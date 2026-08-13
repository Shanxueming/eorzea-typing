/**
 * 本地成绩纪录的分桶单测。
 *
 * ★ 钉死的是 variantKey:每日挑战和错题练习虽然「玩法+难度+输入模式」的组合
 *   和普通局撞在一起,但打的根本不是一回事(固定题目 / 自定义词池)。
 *   没有这一维的话,结算页的「★ 新纪录」「此前最佳」会拿两种局互相比 ——
 *   这类错不会报错也不会崩,只会让玩家看到一个莫名其妙的纪录,很难被发现。
 */
import { describe, it, expect, beforeEach } from 'vitest';

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
};

const { saveRecord, bestRecord } = await import('../src/engine/records');
type Rec = Parameters<typeof saveRecord>[0];

function rec(over: Partial<Rec> = {}): Rec {
  return {
    gameMode: 'standard', difficulty: 'hard', inputMode: 'composed', character: 'p1',
    score: 1000, damage: 5000, wordsCompleted: 20, accuracy: 0.95, cpm: 200,
    victory: true, trustScore: 100, trustFlags: [], recordedAt: Date.now(),
    ...over,
  };
}

beforeEach(() => { store.clear(); });

describe('成绩分桶:玩法+难度+输入模式', () => {
  it('同一条赛道取分数最高的那条', () => {
    saveRecord(rec({ score: 500 }));
    saveRecord(rec({ score: 1500 }));
    saveRecord(rec({ score: 900 }));
    expect(bestRecord('standard', 'hard', 'composed')?.score).toBe(1500);
  });

  it('输入模式不同就不是同一条赛道', () => {
    saveRecord(rec({ inputMode: 'sequential', score: 9999 }));
    expect(bestRecord('standard', 'hard', 'composed')).toBeNull();
  });

  it('无限模式比击杀数,不比分数', () => {
    saveRecord(rec({ gameMode: 'endless', score: 9999, kills: 2 }));
    saveRecord(rec({ gameMode: 'endless', score: 10, kills: 7 }));
    expect(bestRecord('endless', 'hard', 'composed')?.kills).toBe(7);
  });
});

describe('成绩分桶:玩法变体', () => {
  it('★ 每日挑战不会和普通的「标准+困难+组合」混在一起', () => {
    saveRecord(rec({ score: 3000 }));                            // 普通局
    saveRecord(rec({ score: 800, variantKey: 'daily' }));        // 每日挑战

    expect(bestRecord('standard', 'hard', 'composed')?.score).toBe(3000);
    expect(bestRecord('standard', 'hard', 'composed', 'daily')?.score).toBe(800);
  });

  it('★ 错题练习也单独一个桶 —— 词池是自己的,拿去比普通局没意义', () => {
    saveRecord(rec({ difficulty: 'normal', score: 2000 }));
    saveRecord(rec({ difficulty: 'normal', score: 400, variantKey: 'mistake_practice' }));

    expect(bestRecord('standard', 'normal', 'composed')?.score).toBe(2000);
    expect(bestRecord('standard', 'normal', 'composed', 'mistake_practice')?.score).toBe(400);
  });

  it('两个变体之间也互不干扰', () => {
    saveRecord(rec({ score: 111, variantKey: 'daily' }));
    saveRecord(rec({ score: 222, variantKey: 'mistake_practice' }));
    expect(bestRecord('standard', 'hard', 'composed', 'daily')?.score).toBe(111);
    expect(bestRecord('standard', 'hard', 'composed', 'mistake_practice')?.score).toBe(222);
  });

  it('★ 老纪录没有 variantKey,应当被当成普通局(不需要迁移)', () => {
    // 直接写一条没有 variantKey 的旧数据,模拟这次改动之前存下的纪录
    const legacy = rec({ score: 1234 });
    delete (legacy as { variantKey?: unknown }).variantKey;
    store.set('eorzea:records:v1', JSON.stringify([legacy]));

    expect(bestRecord('standard', 'hard', 'composed')?.score).toBe(1234);
    expect(bestRecord('standard', 'hard', 'composed', 'daily')).toBeNull();
  });

  it('只有变体局、没有普通局时,普通桶应该是空的', () => {
    saveRecord(rec({ variantKey: 'daily' }));
    expect(bestRecord('standard', 'hard', 'composed')).toBeNull();
  });
});
