#!/usr/bin/env python3
"""
重建 starter.json(精选起步包),不需要 raw/*.csv。

★ 为什么单独有这个脚本:build_wordbank.py 要从 raw/ 里的官方 CSV 从头解包,
  那批 CSV 不在仓库里(体积大,README 让自己下)。但各分类的 JSON 已经在
  data/wordbanks/ 里了,starter 本来就只是「从各分类里按难度均衡取样」——
  完全可以只用这些 JSON 重建,不必为了调一下配比去重跑整条解包流水线。

★ 取样逻辑与 build_wordbank.py 里 build() 末尾那段**必须保持一致**,
  改了这边记得同步改那边的 STARTER(反之亦然)。跑 --verify 能检查当前
  starter.json 是不是就是这套逻辑产出的。

用法:
    python scripts/rebalance_starter.py --verify   # 用旧配比复现,应与现文件一致
    python scripts/rebalance_starter.py            # 用下面的 STARTER 重新生成
"""
import json
import os
import sys

# Windows 控制台默认是 GBK,打中文和勾叉会直接抛 UnicodeEncodeError
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, '..', 'data', 'wordbanks')

# 调整前的配比,只给 --verify 用:确认本脚本的取样逻辑和当初生成时一致
STARTER_BEFORE = [
    ('jobs', 44, True), ('actions', 400, True), ('craft_actions', 40, True),
    ('places', 300, True), ('monsters', 300, True), ('duties', 150, True),
    ('mounts', 150, True), ('minions', 150, True), ('status', 200, True),
    ('races', 24, True), ('weather', 60, True), ('worlds', 80, True),
    ('characters', 250, True), ('items', 300, True),
]

# ★ 2026-08-12 调整:提高技能名词的比重。
#   起步包(也就是快速开始 / 无限模式 / 每日挑战共用的那个池子)原来技能类
#   只占 308/2156 ≈ 14%,而技能名是这个游戏最有 FF14 味道、也最耐打的一类词
#   (「必杀剑·九天」这种),比例调到约三成。
#
#   ★ 这里的数字是「上限」不是「实取」:取样按难度 1/2/3 三桶各取 cap//3 条,
#     而 actions 的难度3桶(≥7字)总共只有 15 条,craft_actions 的难度3只有 1 条。
#     所以想多取就得把 cap 抬得比"想要的条数"高不少 —— 实际取到多少以脚本
#     打印出来的为准(actions 681 / craft_actions 61),不要看着 1000 就以为
#     真会塞进去一千条技能。
STARTER = [
    ('jobs', 44, True), ('actions', 1000, True), ('craft_actions', 150, True),
    ('places', 300, True), ('monsters', 300, True), ('duties', 150, True),
    ('mounts', 150, True), ('minions', 150, True), ('status', 200, True),
    ('races', 24, True), ('weather', 60, True), ('worlds', 80, True),
    ('characters', 250, True), ('items', 300, True),
]


def load_category(cat):
    with open(os.path.join(OUT, f'{cat}.json'), encoding='utf-8') as f:
        return json.load(f)['entries']


def build_starter(spec):
    """与 build_wordbank.py 的 starter 段逐行等价:按难度 1/2/3 均衡取样"""
    starter = []
    for cat, cap, only_pure in spec:
        pool = load_category(cat)
        if cat == 'characters':
            pool = [e for e in pool if e.get('named')]
        if only_pure:
            pool = [e for e in pool if e['pure']]
        buckets = {1: [], 2: [], 3: []}
        for e in pool:
            buckets[e['difficulty']].append(e)
        per = max(1, cap // 3)
        picked = []
        for lv in (1, 2, 3):
            picked += buckets[lv][:per]
        starter += picked[:cap]
    return starter


def write_starter(entries):
    path = os.path.join(OUT, 'starter.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'category': 'starter', 'label': '精选起步包',
                   'count': len(entries),
                   'note': '各分类难度均衡取样的纯汉字词, 供游戏默认词库使用',
                   'entries': entries}, f, ensure_ascii=False, indent=1)

    # index.json 里的 starter 条目与总数也要跟着走,否则菜单上的数字对不上
    ipath = os.path.join(OUT, 'index.json')
    with open(ipath, encoding='utf-8') as f:
        index = json.load(f)
    for row in index['categories']:
        if row['category'] == 'starter':
            row['count'] = len(entries)
            row['pure'] = len(entries)
    index['starterCount'] = len(entries)
    with open(ipath, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=1)


def summarize(entries):
    from collections import Counter
    c = Counter(e['category'] for e in entries)
    skills = c.get('actions', 0) + c.get('craft_actions', 0)
    print(f'总数 {len(entries)}')
    print(f'技能类(actions+craft_actions) {skills} 条,占 {skills / len(entries) * 100:.1f}%')
    for cat, n in c.most_common():
        print(f'  {cat:15s} {n:5d}')


def main():
    verify = '--verify' in sys.argv
    if verify:
        rebuilt = build_starter(STARTER_BEFORE)
        with open(os.path.join(OUT, 'starter.json'), encoding='utf-8') as f:
            current = json.load(f)['entries']
        same = [e['id'] for e in rebuilt] == [e['id'] for e in current]
        print('用旧配比复现当前 starter.json:', '一致 ✓' if same else '不一致 ✗')
        if not same:
            print(f'  重建 {len(rebuilt)} 条 / 现有 {len(current)} 条')
            sys.exit(1)
        return

    entries = build_starter(STARTER)
    summarize(entries)
    write_starter(entries)
    print('\n已写入 data/wordbanks/starter.json 与 index.json')


if __name__ == '__main__':
    main()
