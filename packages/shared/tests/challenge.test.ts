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
  buildChallengeScript,
  challengeMechanicRoll,
  challengeMechanicSeed,
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
