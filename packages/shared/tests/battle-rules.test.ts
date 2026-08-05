/**
 * 第二轮新增规则的单测:泰坦之怒保底、输入模式按难度收敛。
 * 这两块都是纯函数,行为完全由参数决定,适合用单测钉死数值口径 ——
 * 战斗场景与服务端 Room 各自调用它们,数值跑偏就会两边表现不一致。
 */
import { describe, it, expect } from 'vitest';
import {
  DIFFICULTY_CAST_DURATION_MS,
  DIFFICULTY_DAMAGE_ON_MISS,
  DIFFICULTY_WORD_LENGTH,
  DIFFICULTY_WORD_TIMEOUT_MS,
  MAX_INTERRUPT_WORD_LENGTH,
  TITAN_WRATH_COOLDOWN_WORDS,
  TITAN_WRATH_ON_FAILURE_CHANCE,
  TITAN_WRATH_ON_SUCCESS_CHANCE,
  TITAN_WRATH_PITY_CAP,
  TITAN_WRATH_PITY_STEP,
  allowsComposedInput,
  filterPoolByDifficulty,
  hasTitanWrath,
  resolveInputMode,
  titanWrathChance,
} from '../src/battle';
import type { Difficulty } from '../src/battle';
import type { WordEntry } from '../src/types';

const ALL_DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'hell'];

function word(id: string, typeText: string, difficulty: 1 | 2 | 3): WordEntry {
  return {
    id, text: typeText, typeText, reading: '', category: 'starter', difficulty, pure: true,
  };
}

/** 覆盖 2/3/4/7/9 字,用来验证各档的字数区间边界 */
const POOL: WordEntry[] = [
  word('w2', '铁壁', 1),                    // 2 字
  word('w3', '斗狮者', 1),                  // 3 字
  word('w4', '优雷卡丰', 2),                // 4 字
  word('w7', '冰属性耐性降低', 3),          // 7 字
  word('w9', '亚拉戈市场遗迹废墟', 3),      // 9 字
];

const lengthsOf = (list: WordEntry[]) => list.map((w) => w.typeText.length).sort((a, b) => a - b);

describe('泰坦之怒保底(规则一:概率随词数递增)', () => {
  it('冷却窗口之后,每多打一个词概率就在基础值上多加一个 STEP', () => {
    const at3 = titanWrathChance(TITAN_WRATH_ON_SUCCESS_CHANCE, 3, 'normal');
    const at4 = titanWrathChance(TITAN_WRATH_ON_SUCCESS_CHANCE, 4, 'normal');
    expect(at4 - at3).toBeCloseTo(TITAN_WRATH_PITY_STEP, 10);
  });

  it('攒得再久也不会超过上限', () => {
    expect(titanWrathChance(TITAN_WRATH_ON_SUCCESS_CHANCE, 999, 'normal')).toBe(TITAN_WRATH_PITY_CAP);
  });

  it('打错的基础概率比打对高,同样词数下前者更容易触发', () => {
    const n = TITAN_WRATH_COOLDOWN_WORDS;
    expect(titanWrathChance(TITAN_WRATH_ON_FAILURE_CHANCE, n, 'normal'))
      .toBeGreaterThan(titanWrathChance(TITAN_WRATH_ON_SUCCESS_CHANCE, n, 'normal'));
  });
});

describe('泰坦之怒保底(规则二:触发后的冷却窗口)', () => {
  it('★ 触发后 COOLDOWN_WORDS 个词内概率恒为 0', () => {
    for (let n = 0; n < TITAN_WRATH_COOLDOWN_WORDS; n++) {
      expect(titanWrathChance(TITAN_WRATH_ON_SUCCESS_CHANCE, n, 'normal')).toBe(0);
      expect(titanWrathChance(TITAN_WRATH_ON_FAILURE_CHANCE, n, 'hard')).toBe(0);
    }
  });

  it('窗口一过立刻恢复成正数', () => {
    expect(titanWrathChance(TITAN_WRATH_ON_SUCCESS_CHANCE, TITAN_WRATH_COOLDOWN_WORDS, 'normal'))
      .toBeGreaterThan(0);
  });

  it('★ 地狱难度不吃这层冷却:刚触发完也可能再来一次', () => {
    expect(titanWrathChance(TITAN_WRATH_ON_SUCCESS_CHANCE, 0, 'hell'))
      .toBe(TITAN_WRATH_ON_SUCCESS_CHANCE);
  });
});

describe('输入模式按难度收敛', () => {
  it('地狱以外都允许组合输入', () => {
    expect(allowsComposedInput('easy')).toBe(true);
    expect(allowsComposedInput('normal')).toBe(true);
    expect(allowsComposedInput('hard')).toBe(true);
  });

  it('★ 地狱强制逐字 —— 「打错立刻判负」与「错了可以改」不能共存', () => {
    expect(allowsComposedInput('hell')).toBe(false);
    expect(resolveInputMode('hell', 'composed')).toBe('sequential');
  });

  it('其余难度原样尊重玩家的选择', () => {
    expect(resolveInputMode('normal', 'composed')).toBe('composed');
    expect(resolveInputMode('normal', 'sequential')).toBe('sequential');
    expect(resolveInputMode('hard', 'composed')).toBe('composed');
  });
});

describe('难度数值表', () => {
  it('普通词限时逐档收紧:25s / 16s / 12s / 9s', () => {
    expect(DIFFICULTY_WORD_TIMEOUT_MS.easy).toBe(25_000);
    expect(DIFFICULTY_WORD_TIMEOUT_MS.normal).toBe(16_000);
    expect(DIFFICULTY_WORD_TIMEOUT_MS.hard).toBe(12_000);
    expect(DIFFICULTY_WORD_TIMEOUT_MS.hell).toBe(9_000);
  });

  it('读条窗口逐档收紧:普通 10s / 困难 6.5s / 地狱 5s', () => {
    expect(DIFFICULTY_CAST_DURATION_MS.normal).toBe(10_000);
    expect(DIFFICULTY_CAST_DURATION_MS.hard).toBe(6_500);
    expect(DIFFICULTY_CAST_DURATION_MS.hell).toBe(5_000);
  });

  it('打错扣血逐档加重:3 / 5 / 10 / 20', () => {
    expect(DIFFICULTY_DAMAGE_ON_MISS.easy).toBe(3);
    expect(DIFFICULTY_DAMAGE_ON_MISS.normal).toBe(5);
    expect(DIFFICULTY_DAMAGE_ON_MISS.hard).toBe(10);
    expect(DIFFICULTY_DAMAGE_ON_MISS.hell).toBe(20);
  });

  it('★ 四档之间必须严格单调,不能出现「更高难度反而更宽松」', () => {
    for (let i = 1; i < ALL_DIFFICULTIES.length; i++) {
      const prev = ALL_DIFFICULTIES[i - 1];
      const cur = ALL_DIFFICULTIES[i];
      expect(DIFFICULTY_WORD_TIMEOUT_MS[cur]).toBeLessThan(DIFFICULTY_WORD_TIMEOUT_MS[prev]);
      expect(DIFFICULTY_DAMAGE_ON_MISS[cur]).toBeGreaterThan(DIFFICULTY_DAMAGE_ON_MISS[prev]);
    }
  });
});

describe('简单难度不触发泰坦之怒', () => {
  it('hasTitanWrath 只对简单返回 false', () => {
    expect(hasTitanWrath('easy')).toBe(false);
    expect(hasTitanWrath('normal')).toBe(true);
    expect(hasTitanWrath('hard')).toBe(true);
    expect(hasTitanWrath('hell')).toBe(true);
  });

  it('★ 简单难度下概率恒为 0,再怎么攒保底也不会出', () => {
    for (const n of [0, 3, 10, 999]) {
      expect(titanWrathChance(TITAN_WRATH_ON_SUCCESS_CHANCE, n, 'easy')).toBe(0);
      expect(titanWrathChance(TITAN_WRATH_ON_FAILURE_CHANCE, n, 'easy')).toBe(0);
    }
  });
});

describe('难度分布(按判定字符数筛)', () => {
  it('简单 1~3 字:只出短词', () => {
    expect(lengthsOf(filterPoolByDifficulty(POOL, 'easy'))).toEqual([2, 3]);
  });

  it('普通 1~6 字:不出 7 字以上的长词', () => {
    expect(lengthsOf(filterPoolByDifficulty(POOL, 'normal'))).toEqual([2, 3, 4]);
  });

  it('★ 困难 3~7 字:两头都掐 —— 不出 2 字短词,也不出 8 字以上超长词', () => {
    expect(lengthsOf(filterPoolByDifficulty(POOL, 'hard'))).toEqual([3, 4, 7]);
  });

  it('困难与地狱共用同一批词(地狱的难度来自限时与逐字输入,不是字数)', () => {
    expect(DIFFICULTY_WORD_LENGTH.hell).toEqual(DIFFICULTY_WORD_LENGTH.hard);
    expect(filterPoolByDifficulty(POOL, 'hell').map((w) => w.id))
      .toEqual(filterPoolByDifficulty(POOL, 'hard').map((w) => w.id));
  });

  it('按 typeText 而不是 text 算字数 —— 带标点的词以实际要敲的字符数为准', () => {
    const punctuated: WordEntry = {
      id: 'p', text: '必杀剑·九天', typeText: '必杀剑九天',
      reading: '', category: 'actions', difficulty: 2, pure: false,
    };
    // 展示 6 个字符、判定 5 个字符;困难档上限 7,两种口径都能进,
    // 但普通档上限 6 只有按 typeText(5 字)算才进得去
    expect(filterPoolByDifficulty([punctuated], 'normal')).toHaveLength(1);
  });

  it('★ 筛完为空时退回原池,绝不能让玩家开不了局', () => {
    const onlyShort = [word('x', '铁壁', 1)];
    expect(filterPoolByDifficulty(onlyShort, 'hard')).toHaveLength(1);
  });

  it('不改动传入的数组', () => {
    const before = POOL.length;
    filterPoolByDifficulty(POOL, 'easy');
    expect(POOL).toHaveLength(before);
  });
});

describe('打断词池不能按难度筛', () => {
  it('★ 按难度筛过的池里短词更少,所以打断词必须用完整池', () => {
    const shortInHard = filterPoolByDifficulty(POOL, 'hard')
      .filter((w) => w.typeText.length <= MAX_INTERRUPT_WORD_LENGTH);
    const shortInFull = POOL.filter((w) => w.typeText.length <= MAX_INTERRUPT_WORD_LENGTH);
    // 这条断言就是那个坑本身:筛过的池里短词严格少于完整池。困难档掐掉了 2 字词,
    // 可选的打断词随之变少;自定义分类下完全可能一个都不剩,泰坦之怒就静默失效了。
    expect(shortInHard.length).toBeLessThan(shortInFull.length);
    expect(shortInFull.length).toBeGreaterThan(0);
  });
});
