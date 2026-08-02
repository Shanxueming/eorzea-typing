#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FF14 国服专有名词词库构建器 v2
数据源: thewakingsands/ffxiv-datamining-cn (SaintCoinach CSV, 国服客户端解包)

v2 相对 v1 的修正:
  1. 过滤日文假名残留与 ● 符号等未本地化条目
  2. 新增 typeText 字段 —— 去除中点/冒号等难输入标点后的判定文本
     (保留 "必杀剑·九天" 的显示原文, 判定只需打 "必杀剑九天")
  3. 新增 pure 标记 —— 是否为纯汉字, 便于游戏筛选最佳打字体验
  4. worlds 分类剔除内部代号泄漏 (如 "陆行鸟s-guttata")
  5. characters 增加 named 启发式 —— 区分具名角色与路人 NPC
  6. 额外产出 starter.json 精选包, 供游戏默认词库直接使用
"""
import csv, json, os, re, sys
from collections import OrderedDict
from pypinyin import lazy_pinyin

csv.field_size_limit(10 ** 9)
BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, 'raw')
OUT = os.path.join(BASE, 'wordbanks')

HAN = re.compile(r'[\u4e00-\u9fff]')
KANA = re.compile(r'[\u3040-\u30ff]')          # 平假名/片假名 = 未本地化
LATIN = re.compile(r'[A-Za-z]')
NOT_HAN = re.compile(r'[^\u4e00-\u9fff]')
# 判定时需剥离的分隔标点(显示保留, 输入免打)
STRIP_FOR_TYPING = re.compile(r'[·・：:，,、。．\.\-—~～\s"“”\'‘’!！?？/\\|（）()\[\]【】《》<>]')
TAG = re.compile(r'<[^>]*>')
CTRL = re.compile(r'[\x00-\x1f\x7f]')
SYMBOL = re.compile(r'[●○■□▲△★☆◆◇※→←↑↓]')

BAD_SUBSTR = [
    '？？？', '???', 'ダミー', 'dummy', 'Dummy', 'DUMMY', 'デバッグ',
    'debug', 'Debug', 'DEBUG', 'テスト', '未使用', '未实装', '删除',
    '無効', '无效', 'ＮＰＣ用', '不使用', 'ItemName', 'PlaceName',
    'null', 'NULL', 'テスト用', '仮', 'コピー',
]
BAD_EXACT = {'', '0', '-', '—', '无', '空', '？', '?'}

# 路人 NPC 的典型后缀 —— 用于 named 启发式
GENERIC_SUFFIX = (
    '市民', '商人', '卫兵', '冒险者', '居民', '旅人', '士兵', '船员',
    '学者', '工匠', '农民', '渔夫', '猎人', '难民', '孩子', '老人',
    '青年', '少女', '少年', '男子', '女子', '员工', '客人', '侍从',
    '骑士', '水手', '海盗', '奴隶', '信徒', '祭司', '学徒', '帮工',
)


def clean(s: str) -> str:
    if not s:
        return ''
    s = TAG.sub('', s)
    s = CTRL.sub('', s)
    s = SYMBOL.sub('', s)
    s = s.replace('\u3000', '').replace('\ufeff', '')
    s = re.sub(r'\s+', '', s)
    return s.strip()


def type_text(s: str) -> str:
    """生成判定用文本: 剥离难输入的分隔标点"""
    return STRIP_FOR_TYPING.sub('', s)


def valid(s: str, min_len=2, max_len=16) -> bool:
    if s in BAD_EXACT:
        return False
    if any(b in s for b in BAD_SUBSTR):
        return False
    if KANA.search(s):                 # 未本地化的日文条目
        return False
    if not HAN.search(s):
        return False
    t = type_text(s)
    if not (min_len <= len(t) <= max_len):
        return False
    if t.isdigit():
        return False
    return True


def difficulty(t: str) -> int:
    n = len(t)
    if n <= 3:
        return 1
    if n <= 6:
        return 2
    return 3


def load(sheet):
    path = os.path.join(RAW, sheet + '.csv')
    if not os.path.exists(path):
        return None, iter([])
    r = csv.reader(open(path, encoding='utf-8-sig', newline=''))
    next(r)
    names = next(r)
    next(r)
    idx = {}
    for i, n in enumerate(names):
        if n and n not in idx:
            idx[n] = i
    return idx, r


def get(row, idx, col, d=''):
    i = idx.get(col)
    return row[i] if (i is not None and i < len(row)) else d


def num(v, d=0):
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return d


def extract(sheet, cols, keep=None, min_len=2, max_len=16):
    idx, rows = load(sheet)
    if idx is None:
        print(f'  [skip] {sheet}', file=sys.stderr)
        return []
    out = []
    for row in rows:
        if not row:
            continue
        if keep and not keep(row, idx):
            continue
        raw = ''
        for c in cols:
            v = get(row, idx, c)
            if v and v.strip():
                raw = v
                break
        s = clean(raw)
        if valid(s, min_len, max_len):
            out.append(s)
    return out


# 服务器表: 剔除含拉丁字母的内部代号
def keep_world(r, i):
    return not LATIN.search(get(r, i, 'Name'))


CATEGORIES = OrderedDict([
    ('jobs',        dict(label='职业与职能', prefix='job',
                         sheets=[('ClassJob', ['Name'], None)])),
    ('actions',     dict(label='战斗技能', prefix='act',
                         sheets=[('Action', ['Name'],
                                  lambda r, i: num(get(r, i, 'ClassJobLevel')) > 0)])),
    ('craft_actions', dict(label='生产技能', prefix='cft',
                           sheets=[('CraftAction', ['Name'], None)])),
    ('traits',      dict(label='特性', prefix='trt',
                         sheets=[('Trait', ['Name'], None)])),
    ('status',      dict(label='状态效果', prefix='sts',
                         sheets=[('Status', ['Name'], None)])),
    ('characters',  dict(label='人物与NPC', prefix='chr',
                         sheets=[('ENpcResident', ['Singular'], None)])),
    ('monsters',    dict(label='怪物与敌人', prefix='mob',
                         sheets=[('BNpcName', ['Singular'], None)])),
    ('places',      dict(label='地名', prefix='plc',
                         sheets=[('PlaceName', ['Name'], None),
                                 ('TerritoryType', ['Name'], None)])),
    ('duties',      dict(label='副本与挑战', prefix='dut', max_len=24,
                         sheets=[('ContentFinderCondition', ['Name'], None)])),
    ('quests',      dict(label='任务', prefix='qst', max_len=24,
                         sheets=[('Quest', ['Name'], None)])),
    ('items',       dict(label='道具与装备', prefix='itm', max_len=20,
                         sheets=[('Item', ['Name', 'Singular'], None)])),
    ('mounts',      dict(label='坐骑', prefix='mnt',
                         sheets=[('Mount', ['Singular'], None)])),
    ('minions',     dict(label='宠物', prefix='min',
                         sheets=[('Companion', ['Singular'], None)])),
    ('emotes',      dict(label='情感动作', prefix='emo',
                         sheets=[('Emote', ['Name'], None)])),
    ('fates',       dict(label='FATE事件', prefix='fat', max_len=20,
                         sheets=[('Fate', ['Name'], None)])),
    ('titles',      dict(label='称号', prefix='ttl',
                         sheets=[('Title', ['Masculine'], None)])),
    ('achievements', dict(label='成就', prefix='ach', max_len=20,
                          sheets=[('Achievement', ['Name'], None)])),
    ('races',       dict(label='种族与部族', prefix='rce',
                         sheets=[('Race', ['Masculine'], None),
                                 ('Tribe', ['Masculine'], None)])),
    ('weather',     dict(label='天气', prefix='wth',
                         sheets=[('Weather', ['Name'], None)])),
    ('worlds',      dict(label='服务器与大区', prefix='wld',
                         sheets=[('World', ['Name'], keep_world)])),
    ('music',       dict(label='乐曲', prefix='msc', max_len=20,
                         sheets=[('Orchestrion', ['Name'], None)])),
])

# starter 精选包的组成: (分类, 取多少条, 是否只要纯汉字)
STARTER = [
    ('jobs', 44, True), ('actions', 400, True), ('craft_actions', 40, True),
    ('places', 300, True), ('monsters', 300, True), ('duties', 150, True),
    ('mounts', 150, True), ('minions', 150, True), ('status', 200, True),
    ('races', 24, True), ('weather', 60, True), ('worlds', 80, True),
    ('characters', 250, True), ('items', 300, True),
]


def is_named_character(t: str) -> bool:
    """具名角色启发式: 不含'的', 无路人后缀, 长度适中"""
    if '的' in t or len(t) > 7:
        return False
    return not t.endswith(GENERIC_SUFFIX)


def build():
    os.makedirs(OUT, exist_ok=True)
    index, total = [], 0
    all_data = {}

    for cat, cfg in CATEGORIES.items():
        seen, entries = set(), []
        for sheet, cols, keep in cfg['sheets']:
            for s in extract(sheet, cols, keep,
                             cfg.get('min_len', 2), cfg.get('max_len', 16)):
                if s not in seen:
                    seen.add(s)
                    entries.append(s)

        entries.sort(key=lambda s: (len(type_text(s)), s))
        packed = []
        for n, text in enumerate(entries, 1):
            tt = type_text(text)
            item = {
                'id': f"{cfg['prefix']}_{n:05d}",
                'text': text,
                'typeText': tt,
                'reading': ' '.join(lazy_pinyin(tt)),
                'category': cat,
                'difficulty': difficulty(tt),
                'pure': not bool(NOT_HAN.search(text)),
            }
            if cat == 'characters':
                item['named'] = is_named_character(text)
            packed.append(item)

        all_data[cat] = packed
        with open(os.path.join(OUT, f'{cat}.json'), 'w', encoding='utf-8') as f:
            json.dump({'category': cat, 'label': cfg['label'],
                       'count': len(packed),
                       'source': 'thewakingsands/ffxiv-datamining-cn',
                       'entries': packed}, f, ensure_ascii=False, indent=1)

        d = [0, 0, 0]
        pure = 0
        for e in packed:
            d[e['difficulty'] - 1] += 1
            pure += e['pure']
        index.append({'category': cat, 'label': cfg['label'],
                      'count': len(packed), 'pure': pure,
                      'file': f'{cat}.json',
                      'byDifficulty': {'1': d[0], '2': d[1], '3': d[2]}})
        total += len(packed)
        print(f"{cfg['label']:12s} {cat:14s} {len(packed):7,d} 条  "
              f"纯汉字 {pure:6,d}  (易{d[0]:,} 中{d[1]:,} 难{d[2]:,})")

    # ── starter 精选包 ──
    starter = []
    for cat, cap, only_pure in STARTER:
        pool = all_data.get(cat, [])
        if cat == 'characters':
            pool = [e for e in pool if e.get('named')]
        if only_pure:
            pool = [e for e in pool if e['pure']]
        # 按难度均衡取样
        buckets = {1: [], 2: [], 3: []}
        for e in pool:
            buckets[e['difficulty']].append(e)
        per = max(1, cap // 3)
        picked = []
        for lv in (1, 2, 3):
            picked += buckets[lv][:per]
        starter += picked[:cap]

    with open(os.path.join(OUT, 'starter.json'), 'w', encoding='utf-8') as f:
        json.dump({'category': 'starter', 'label': '精选起步包',
                   'count': len(starter),
                   'note': '各分类难度均衡取样的纯汉字词, 供游戏默认词库使用',
                   'entries': starter}, f, ensure_ascii=False, indent=1)

    index.append({'category': 'starter', 'label': '精选起步包',
                  'count': len(starter), 'pure': len(starter),
                  'file': 'starter.json'})

    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'total': total, 'starterCount': len(starter),
                   'source': 'thewakingsands/ffxiv-datamining-cn',
                   'categories': index}, f, ensure_ascii=False, indent=1)

    print(f"\n精选起步包   starter        {len(starter):7,d} 条")
    print(f"合计 {total:,} 条 -> {OUT}")


if __name__ == '__main__':
    build()
