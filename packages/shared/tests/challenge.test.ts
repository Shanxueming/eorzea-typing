/**
 * 挑战赛道剧本的单测。
 *
 * ★ 这里钉死的是「可比性」本身:同一个 seed 必须在任何机器、任何时刻算出
 *   完全相同的剧本,否则每日挑战/赛事的成绩之间就没有可比性了。
 */
import { describe, it, expect } from 'vitest';
import {
  CHALLENGE_MECHANIC_MAX_GAP,
  CHALLENGE_MECHANIC_MIN_GAP,
  CHALLENGE_SCRIPT_WORDS,
  DAILY_WINDOW_MS,
  buildChallengeScript,
  challengeMechanicRoll,
  challengeMechanicSeed,
  dailyDateKey,
  dailyPeriod,
  dailySeed,
  mechanicAt,
} from '../src/challenge';
import { MECHANICS } from '../src/mechanics';

describe('挑战剧本:确定性', () => {
  it('★ 同一个 seed 生成完全相同的剧本 —— 挑战赛道可比性的地基', () => {
    const a = buildChallengeScript('daily-2026-08-11');
    const b = buildChallengeScript('daily-2026-08-11');
    expect(a).toEqual(b);
  });

  it('不同 seed 生成不同剧本', () => {
    const a = buildChallengeScript('daily-2026-08-11');
    const b = buildChallengeScript('daily-2026-08-12');
    expect(a.mechanics).not.toEqual(b.mechanics);
  });

  it('★ 剧本只由 seed 决定,和玩家表现无关 —— 纯函数,没有任何外部输入', () => {
    // 连续调用之间不共享任何状态:第 10 次调用和第 1 次必须一模一样
    const first = buildChallengeScript('same-seed');
    for (let i = 0; i < 10; i++) buildChallengeScript(`noise-${i}`);
    expect(buildChallengeScript('same-seed')).toEqual(first);
  });

  it('机制的 seed 与 roll 同样只由「战斗 seed + 第几个词」决定', () => {
    expect(challengeMechanicSeed('s', 7)).toBe(challengeMechanicSeed('s', 7));
    expect(challengeMechanicSeed('s', 7)).not.toBe(challengeMechanicSeed('s', 8));
    expect(challengeMechanicRoll('s', 7)).toBe(challengeMechanicRoll('s', 7));
    expect(challengeMechanicRoll('s', 7)).not.toBe(challengeMechanicRoll('s', 8));
  });

  it('roll 落在 [0, 1) —— createMechanicState 拿它决定三连桶出生方向', () => {
    for (let i = 1; i <= 50; i++) {
      const roll = challengeMechanicRoll('seed', i);
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(1);
    }
  });
});

describe('挑战剧本:排布规则', () => {
  it('机制按 afterWord 严格递增,不会两条挤在同一个词上', () => {
    const script = buildChallengeScript('seed-order');
    for (let i = 1; i < script.mechanics.length; i++) {
      expect(script.mechanics[i].afterWord).toBeGreaterThan(script.mechanics[i - 1].afterWord);
    }
  });

  it('★ 相邻两次机制的间隔落在 [MIN_GAP, MAX_GAP] —— 不会连着炸也不会整局不出', () => {
    for (let s = 0; s < 30; s++) {
      const script = buildChallengeScript(`gap-${s}`);
      let prev = 0;
      for (const m of script.mechanics) {
        const gap = m.afterWord - prev;
        expect(gap).toBeGreaterThanOrEqual(CHALLENGE_MECHANIC_MIN_GAP);
        expect(gap).toBeLessThanOrEqual(CHALLENGE_MECHANIC_MAX_GAP);
        prev = m.afterWord;
      }
    }
  });

  it('不会排到 CHALLENGE_SCRIPT_WORDS 之外', () => {
    const script = buildChallengeScript('seed-bound');
    for (const m of script.mechanics) {
      expect(m.afterWord).toBeLessThanOrEqual(CHALLENGE_SCRIPT_WORDS);
    }
  });

  it('排出来的机制 id 都是真实存在的机制', () => {
    const script = buildChallengeScript('seed-ids');
    expect(script.mechanics.length).toBeGreaterThan(0);
    for (const m of script.mechanics) {
      expect(MECHANICS[m.id]).toBeDefined();
    }
  });

  it('三种机制在足够长的剧本里都会出现,不会退化成只出一种', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 20; s++) {
      for (const m of buildChallengeScript(`variety-${s}`).mechanics) seen.add(m.id);
    }
    expect(seen.size).toBe(3);
  });
});

describe('mechanicAt', () => {
  it('排到的词序号返回对应机制,没排到的返回 null', () => {
    const script = buildChallengeScript('seed-lookup');
    const first = script.mechanics[0];
    expect(mechanicAt(script, first.afterWord)).toBe(first.id);
    // 剧本里两次机制至少隔 MIN_GAP 个词,所以 first 的前一个词一定没有机制
    expect(mechanicAt(script, first.afterWord - 1)).toBeNull();
  });

  it('词序号超出剧本范围时返回 null,不抛错', () => {
    const script = buildChallengeScript('seed-oob');
    expect(mechanicAt(script, CHALLENGE_SCRIPT_WORDS + 100)).toBeNull();
    expect(mechanicAt(script, 0)).toBeNull();
  });
});

describe('每日挑战:按北京时间自然日切分', () => {
  /** 北京时间 2026-08-11 09:30 */
  const morning = Date.parse('2026-08-11T09:30:00+08:00');
  /** 同一天的深夜 23:59 —— 关键边界:它必须和上面算出同一天 */
  const lateNight = Date.parse('2026-08-11T23:59:00+08:00');
  /** 刚过零点,已经是新的一天了 */
  const justAfterMidnight = Date.parse('2026-08-12T00:00:30+08:00');

  it('★ 同一个北京自然日内,不管几点算出来都是同一个 seed', () => {
    expect(dailySeed(morning)).toBe(dailySeed(lateNight));
    expect(dailyDateKey(morning)).toBe('2026-08-11');
    expect(dailyDateKey(lateNight)).toBe('2026-08-11');
  });

  it('★ 北京时间零点换题,不是 UTC 零点(那样会变成早上 8 点换)', () => {
    expect(dailySeed(justAfterMidnight)).not.toBe(dailySeed(lateNight));
    expect(dailyDateKey(justAfterMidnight)).toBe('2026-08-12');
  });

  it('一轮正好 24 小时,首尾相接没有空隙', () => {
    const today = dailyPeriod(morning, 0);
    const yesterday = dailyPeriod(morning, 1);
    expect(today.end - today.start).toBe(DAILY_WINDOW_MS);
    expect(yesterday.end).toBe(today.start);
  });

  it('区间起点确实是北京时间当天 00:00', () => {
    const { start } = dailyPeriod(morning, 0);
    expect(start).toBe(Date.parse('2026-08-11T00:00:00+08:00'));
  });

  it('offset 往回翻能拿到过去几天的 seed,且各不相同', () => {
    const seeds = [0, 1, 2, 3].map((o) => dailySeed(morning, o));
    expect(new Set(seeds).size).toBe(4);
    expect(seeds[1]).toBe('daily-2026-08-10');
  });

  it('★ 每日 seed 喂给 buildChallengeScript 时,当天所有人拿到同一份剧本', () => {
    const a = buildChallengeScript(dailySeed(morning));
    const b = buildChallengeScript(dailySeed(lateNight));
    expect(a).toEqual(b);
  });
});
