#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FF7(最终幻想7)中文专有名词词库构建器。

数据源:V-Lipset/ao3-chinese 的 glossaries/最终幻想Ⅶ.txt(GPL-3.0),
一份人工维护的 FF7 中文译名对照表。这里只取它的**中文侧专有名词**——
「克劳德」「米德加」这类是史克威尔官方中文译名,属于游戏本身的事实性术语。

★ 与 build_wordbank.py(FF14)的关系:字段口径必须完全一致,否则前端拿到
  形状不同的条目会在判定流水线上出问题。type_text / difficulty / pure 三个
  规则都是照抄那边的,改动前先看那个文件。

★ 拼音不能无脑信 pypinyin:多音字是这个项目反复踩坑的地方(都/重/应/厦…)。
  下面 READING_OVERRIDE 是人工核对过的订正表,新增词条时必须重新过一遍
  `python scripts/build_ff7_wordbank.py --review` 的输出。
"""
import json, os, re, sys
from pypinyin import lazy_pinyin

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(BASE), 'data', 'wordbanks')
SRC = os.path.join(BASE, 'raw', 'ff7-glossary.txt')

# ── 以下三条规则与 build_wordbank.py 保持一致,不要各写一份 ──
NOT_HAN = re.compile(r'[^一-鿿]')
STRIP_FOR_TYPING = re.compile(
    r'[·・：:，,、。．\.\-—~～\s"“”\'‘’!！?？/\\|（）()\[\]【】《》<>]')
HAN = re.compile(r'[一-鿿]')


def type_text(s: str) -> str:
    return STRIP_FOR_TYPING.sub('', s)


def difficulty(t: str) -> int:
    n = len(t)
    if n <= 3:
        return 1
    if n <= 6:
        return 2
    return 3


# ── 人工订正的拼音。key 是 typeText,value 是空格分隔的完整拼音 ──
# 每一条后面都写清楚为什么 —— 不写理由的订正过几个月没人敢动。
READING_OVERRIDE = {
    # 「都」作「城市」讲读 dū,不是「全都」的 dōu
    '遗忘之都': 'yi wang zhi du',
    '都市建设部': 'du shi jian she bu',
    # 「重聚」= chóng jù(再次相聚),不是 zhòng
    '重聚理论': 'chong ju li lun',
    # 「应许」= yīng xǔ,不是 yìng
    '应许之地': 'ying xu zhi di',
    # 「大厦」= dà shà,不是 dà xià
    '神罗大厦': 'shen luo da sha',
    # 「中毒」= zhòng dú,不是 zhōng
    '魔晄中毒': 'mo huang zhong du',
    # 「陆行鸟」沿用 FF14 词库的既有读法 lù xíng niǎo
    '陆行鸟': 'lu xing niao',
    '陆行鸟农场': 'lu xing niao nong chang',
    # Tseng 的译名「曾」是姓氏音 zēng,不是「曾经」的 céng
    '曾': 'zeng',
    # 音译名里的「勒」读 lè(巴勒斯坦、迦巴勒),不是「勒紧」的 lēi。
    # FF14 词库 218 条「勒」全是 le,这里跟它保持一致。
    '爱丽丝盖恩斯巴勒': 'ai li si gai en si ba le',
}


def parse_glossary(path: str):
    """取出 `English：中文` 里的中文侧;跳过注释/分节标题/未翻译条目"""
    out = []
    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('//'):
                continue
            # 元信息与分节标题(版本号:… / 词条 / 通用词条 / 禁翻词条)
            if '：' not in line:
                continue
            left, _, right = line.partition('：')
            zh = right.strip()
            # 「版本号:1.0.0」这类元信息:右侧没有汉字,直接丢
            if not HAN.search(zh):
                continue
            out.append(zh)
    return out


def build(review_only: bool = False) -> int:
    if not os.path.exists(SRC):
        print(f'找不到数据源:{SRC}\n'
              f'请先下载:curl -sL "https://raw.githubusercontent.com/V-Lipset/'
              f'ao3-chinese/main/glossaries/%E6%9C%80%E7%BB%88%E5%B9%BB%E6%83%B3'
              f'%E2%85%A6.txt" -o "{SRC}"', file=sys.stderr)
        return 1

    terms = parse_glossary(SRC)

    # 去重但保留首次出现的顺序,再按「判定长度 → 字面」排序,与 FF14 词库一致。
    # ★ 单字条目要丢掉:FF14 那边是 min_len=2,单个字("曾"= Tseng)当打字目标
    #   既没手感、又容易和输入法候选撞车,两边口径必须一致。
    seen, uniq = set(), []
    for t in terms:
        if t not in seen and len(type_text(t)) >= 2:
            seen.add(t)
            uniq.append(t)
    uniq.sort(key=lambda s: (len(type_text(s)), s))

    packed = []
    for n, text in enumerate(uniq, 1):
        tt = type_text(text)
        auto = ' '.join(lazy_pinyin(tt))
        reading = READING_OVERRIDE.get(tt, auto)
        packed.append({
            'id': f'ff7_{n:05d}',
            'text': text,
            'typeText': tt,
            'reading': reading,
            'category': 'ff7',
            'difficulty': difficulty(tt),
            'pure': not bool(NOT_HAN.search(text)),
            '_auto': auto,          # 仅 --review 用,写文件前会删掉
        })

    if review_only:
        print(f'共 {len(packed)} 条。带 * 的是人工订正过的:\n')
        for e in packed:
            mark = ' *' if e['reading'] != e['_auto'] else '  '
            extra = f"   (pypinyin: {e['_auto']})" if mark == ' *' else ''
            print(f"{mark} {e['text']:<16} {e['reading']}{extra}")
        return 0

    for e in packed:
        e.pop('_auto', None)

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, 'ff7.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({
            'category': 'ff7',
            'label': '最终幻想7',
            'count': len(packed),
            'source': 'V-Lipset/ao3-chinese (GPL-3.0) glossaries/最终幻想Ⅶ.txt',
            'entries': packed,
        }, f, ensure_ascii=False, indent=1)

    d = [0, 0, 0]
    pure = 0
    for e in packed:
        d[e['difficulty'] - 1] += 1
        pure += e['pure']
    print(f'写出 {path}')
    print(f'  条目 {len(packed)}  纯汉字 {pure}  难度分布 易{d[0]}/中{d[1]}/难{d[2]}')

    merge_index(len(packed), pure, d)
    return 0


def merge_index(count: int, pure: int, d) -> None:
    """
    把 ff7 这一条合并进 index.json。

    ★ 用「合并」而不是重写整个索引:index.json 的主体由 build_wordbank.py(FF14)
      生成,那边一跑就会把 ff7 这条冲掉。所以顺序永远是
      `build_wordbank.py` → `build_ff7_wordbank.py`,后者补回自己那条。
    """
    path = os.path.join(OUT, 'index.json')
    with open(path, encoding='utf-8') as f:
        idx = json.load(f)

    row = {'category': 'ff7', 'label': '最终幻想7', 'count': count,
           'pure': pure, 'file': 'ff7.json',
           'byDifficulty': {'1': d[0], '2': d[1], '3': d[2]}}

    cats = [c for c in idx['categories'] if c['category'] != 'ff7']
    # 「精选起步包」是特殊条目,始终排在最后,新分类插到它前面
    at = next((i for i, c in enumerate(cats) if c['category'] == 'starter'), len(cats))
    cats.insert(at, row)
    idx['categories'] = cats
    # total 的口径是「不含 starter 的各分类之和」,别把 starter 算进去
    idx['total'] = sum(c['count'] for c in cats if c['category'] != 'starter')

    with open(path, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    print(f"已并入 index.json:total={idx['total']},分类数={len(cats)}")


if __name__ == '__main__':
    sys.exit(build(review_only='--review' in sys.argv))
