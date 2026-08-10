/**
 * 第二轮新增规则的单测:泰坦之怒保底、输入模式按难度收敛。
 * 这两块都是纯函数,行为完全由参数决定,适合用单测钉死数值口径 ——
 * 战斗场景与服务端 Room 各自调用它们,数值跑偏就会两边表现不一致。
 */
import { describe, it, expect } from 'vitest';
import {
  BOSS_MAX_HP,
  DIFFICULTY_BOSS_HP_MULTIPLIER,
  DIFFICULTY_CAST_DURATION_MS,
  DIFFICULTY_DAMAGE_ON_MISS,
  DIFFICULTY_WORD_LENGTH,
  DIFFICULTY_WORD_TIMEOUT_MS,
  ENDLESS_MIN_WORD_TIMEOUT_MS,
  ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS,
  HIGH_RISK_POLYPHONES,
  MAX_INTERRUPT_WORD_LENGTH,
  PRIMAL_RELEASE_DAMAGE_MULTIPLIER,
  PRIMAL_RELEASE_HEAL,
  SKILLS,
  TITAN_WRATH_COOLDOWN_WORDS,
  TITAN_WRATH_ON_FAILURE_CHANCE,
  TITAN_WRATH_ON_SUCCESS_CHANCE,
  TITAN_WRATH_PITY_CAP,
  TITAN_WRATH_PITY_STEP,
  acceptedPinyinTargets,
  allowsComposedInput,
  bossHpFor,
  createWordQueue,
  expandPinyinCandidates,
  filterPoolByDifficulty,
  hasTitanWrath,
  pinyinReadingVariants,
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
  it('普通词限时逐档收紧:25s / 16s / 10s / 6.66s', () => {
    expect(DIFFICULTY_WORD_TIMEOUT_MS.easy).toBe(25_000);
    expect(DIFFICULTY_WORD_TIMEOUT_MS.normal).toBe(16_000);
    expect(DIFFICULTY_WORD_TIMEOUT_MS.hard).toBe(10_000);
    expect(DIFFICULTY_WORD_TIMEOUT_MS.hell).toBe(6_660);
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

describe('泰坦血量按难度加厚', () => {
  it('简单/普通是基准值,困难 ×1.625,地狱 ×3.75', () => {
    expect(DIFFICULTY_BOSS_HP_MULTIPLIER.easy).toBe(1);
    expect(DIFFICULTY_BOSS_HP_MULTIPLIER.normal).toBe(1);
    expect(DIFFICULTY_BOSS_HP_MULTIPLIER.hard).toBeCloseTo(1.625, 10);
    expect(DIFFICULTY_BOSS_HP_MULTIPLIER.hell).toBe(3.75);
  });

  it('★ 2026-08-07:困难/地狱在上一版基础上又各加了 25%,bossHpFor 直接反映这个数', () => {
    expect(bossHpFor('hell')).toBe(BOSS_MAX_HP * 3.75);
    expect(bossHpFor('hell')).toBe(22_500);
  });
});

describe('「原初的解放」追加效果:满血翻伤害,没满血就回血', () => {
  it('回血量与伤害倍率的数值口径', () => {
    expect(PRIMAL_RELEASE_HEAL).toBe(10);
    expect(PRIMAL_RELEASE_DAMAGE_MULTIPLIER).toBe(2);
  });

  it('技能描述里带上了这两个数,不能和实际生效的常量脱节', () => {
    expect(SKILLS.p1.description).toContain(`${PRIMAL_RELEASE_HEAL}`);
    expect(SKILLS.p1.description).toContain(`${PRIMAL_RELEASE_DAMAGE_MULTIPLIER}`);
  });
});

describe('无限模式:击杀数联动普通词限时', () => {
  it('每杀一只缩短 300ms,下限 5000ms', () => {
    expect(ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS).toBe(300);
    expect(ENDLESS_MIN_WORD_TIMEOUT_MS).toBe(5_000);
  });

  it('★ 困难档基础限时是 12s,缩到下限之前应该严格递减', () => {
    const base = DIFFICULTY_WORD_TIMEOUT_MS.hard;
    const after10Kills = Math.max(
      ENDLESS_MIN_WORD_TIMEOUT_MS,
      base - 10 * ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS,
    );
    expect(after10Kills).toBe(base - 3_000);
    expect(after10Kills).toBeLessThan(base);
  });

  it('打再多也不会缩到下限以下', () => {
    const base = DIFFICULTY_WORD_TIMEOUT_MS.hard;
    const after999Kills = Math.max(
      ENDLESS_MIN_WORD_TIMEOUT_MS,
      base - 999 * ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS,
    );
    expect(after999Kills).toBe(ENDLESS_MIN_WORD_TIMEOUT_MS);
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

describe('createWordQueue:牌堆不重复', () => {
  it('一副牌堆(pool.length 次连续 next)之内绝不重复', () => {
    const q = createWordQueue(POOL, 'seed-a');
    const seen = new Set<string>();
    for (let i = 0; i < POOL.length; i++) {
      const id = q.next().id;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('★ 2026-08-08:重新洗牌的边界不会背靠背出现同一个词', () => {
    // 小词池(2 个词)让边界撞车的概率被放大很多倍,几千次跑下来只要漏一次就会挂,
    // 足够暴露"两副牌独立洗、边界处 1/N 概率撞同词"这个漏洞。
    const pool = [word('a', '甲', 1), word('b', '乙', 1)];
    for (let s = 0; s < 200; s++) {
      const q = createWordQueue(pool, `seed-${s}`);
      let prev = q.next().id;
      for (let i = 0; i < 500; i++) {
        const cur = q.next().id;
        expect(cur).not.toBe(prev);
        prev = cur;
      }
    }
  });

  it('reset() 之后立刻重洗一副全新的牌,不会沿用上一副剩下的部分', () => {
    const q = createWordQueue(POOL, 'seed-reset');
    q.next();
    q.next();
    q.reset();
    // reset 之后应该能重新走完一整轮 pool.length 次而不重复——
    // 如果 reset 没有真的清空旧牌堆,这里会提前重复或提前触发一次意外的洗牌。
    const seen = new Set<string>();
    for (let i = 0; i < POOL.length; i++) {
      const id = q.next().id;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it('同一个 seed 产生完全相同的序列——联机客户端/服务端各自独立调用也必须一致', () => {
    const a = createWordQueue(POOL, 'shared-seed');
    const b = createWordQueue(POOL, 'shared-seed');
    const seqA = Array.from({ length: POOL.length * 3 }, () => a.next().id);
    const seqB = Array.from({ length: POOL.length * 3 }, () => b.next().id);
    expect(seqA).toEqual(seqB);
  });

  it('只有一个词的池子:允许连续重复(无法避免),不应该抛错或死循环', () => {
    const q = createWordQueue([word('only', '独一', 1)], 'seed-single');
    for (let i = 0; i < 5; i++) {
      expect(q.next().id).toBe('only');
    }
  });
});

/** 带 reading 字段的词条,拼音多音字容错测试专用 */
function pinyinWord(id: string, typeText: string, reading: string): WordEntry {
  return { id, text: typeText, typeText, reading, category: 'starter', difficulty: 1, pure: true };
}

describe('拼音模式多音字容错', () => {
  it('★ 高危字命中时,变体第一项永远是原始 entry 本身', () => {
    const w = pinyinWord('w1', '长城', 'chang cheng');
    const variants = pinyinReadingVariants(w);
    expect(variants[0]).toBe(w);
    expect(variants.length).toBeGreaterThan(1);
    // "长" 在表里还有 zhang 这个读音,应该出现一个 "zhang cheng" 的变体
    expect(variants.map((v) => v.reading)).toContain('zhang cheng');
  });

  it('没踩中任何高危字:只返回原始 entry,不凭空生成变体', () => {
    const w = pinyinWord('w2', '铁壁', 'tie bi');
    expect(pinyinReadingVariants(w)).toEqual([w]);
  });

  it('变体和原词共用同一个 id——多候选判定靠 id 认出"打的是哪个词"', () => {
    const w = pinyinWord('w3', '重要', 'zhong yao');
    const variants = pinyinReadingVariants(w);
    expect(variants.every((v) => v.id === 'w3')).toBe(true);
  });

  it('typeText 字数和 reading 音节数对不上时,不冒险生成变体', () => {
    const w = pinyinWord('w4', '重要', 'zhong yao le'); // 人为制造错位
    expect(pinyinReadingVariants(w)).toEqual([w]);
  });

  it('生僻表里没有的字不受影响,即使读音本身很怪', () => {
    const w = pinyinWord('w5', '铁壁', 'xyz abc');
    expect(pinyinReadingVariants(w)).toEqual([w]);
  });

  it('expandPinyinCandidates 把多个逻辑目标各自展开后拼在一起', () => {
    const a = pinyinWord('a', '长', 'chang');
    const b = pinyinWord('b', '铁壁', 'tie bi');
    const expanded = expandPinyinCandidates([a, b]);
    // a 有变体(chang/zhang 两个),b 没有变体(只有它自己)
    expect(expanded.filter((v) => v.id === 'a').length).toBeGreaterThan(1);
    expect(expanded.filter((v) => v.id === 'b')).toEqual([b]);
  });

  it('acceptedPinyinTargets 返回的判定文本和 judgeInput 的口径一致(空格已去除)', () => {
    const w = pinyinWord('w6', '长城', 'chang cheng');
    const targets = acceptedPinyinTargets(w);
    expect(targets).toContain('changcheng');
    expect(targets).toContain('zhangcheng');
    expect(targets.every((t) => !t.includes(' '))).toBe(true);
  });

  it('★ 服务端(scoreReplay)和客户端(SoloBattle)必须共用同一张表——这里锁死几个已知案例', () => {
    // 这几个字是之前玩家反馈/群里手工修过的真实案例,不能被后续改动误删
    expect(HIGH_RISK_POLYPHONES['都']).toEqual(['dou', 'du']);
    expect(HIGH_RISK_POLYPHONES['的']).toEqual(['de', 'di']);
    expect(HIGH_RISK_POLYPHONES['长']).toContain('chang');
    expect(HIGH_RISK_POLYPHONES['长']).toContain('zhang');
  });
});
