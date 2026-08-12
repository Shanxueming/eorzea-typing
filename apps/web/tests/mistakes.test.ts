/**
 * 错题本的单测。
 *
 * ★ engine/mistakes.ts 只有 type-only import(WordEntry / WordReviewEntry),
 *   运行时不依赖 React 也不依赖 DOM,唯一的外部依赖是 localStorage —— 下面
 *   给它塞一个 Map 实现的替身就能在 node 环境里直接跑。
 * ★ 这里钉死的主要是「毕业」和「上限截断」两条:它们的 bug 不会让程序崩,
 *   只会让错题本慢慢变得没用(永远不减,或者悄悄丢掉最新的错题),
 *   在界面上很难一眼看出来。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { WordEntry } from '@eorzea/shared/types';

// ── localStorage 替身:必须在 import 被测模块之前装好 ──
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
};

const {
  GRADUATE_AFTER_CORRECTS, MAX_MISTAKES,
  recordReviewOutcomes, mistakeCount, listMistakes, mistakePool, clearMistakes,
} = await import('../src/engine/mistakes');

function word(id: string, text: string): WordEntry {
  return { id, text, typeText: text, reading: '', category: 'starter', difficulty: 1, pure: true };
}
const missed = (id: string, text = id) => ({ ...word(id, text), outcome: 'missed' as const });
const correct = (id: string, text = id) => ({ ...word(id, text), outcome: 'correct' as const });

beforeEach(() => { clearMistakes(); });

describe('错题本:记录', () => {
  it('打错的词进本子,打对的不进', () => {
    const added = recordReviewOutcomes([missed('a'), correct('b'), missed('c')]);
    expect(added).toBe(2);
    expect(mistakeCount()).toBe(2);
    expect(listMistakes().map((e) => e.word.id).sort()).toEqual(['a', 'c']);
  });

  it('同一个词再错一次只加次数,不会变成两条', () => {
    recordReviewOutcomes([missed('a')]);
    const added = recordReviewOutcomes([missed('a')]);
    expect(added).toBe(0);
    expect(mistakeCount()).toBe(1);
    expect(listMistakes()[0].misses).toBe(2);
  });

  it('空复盘不写任何东西', () => {
    recordReviewOutcomes([]);
    expect(mistakeCount()).toBe(0);
  });

  it('本子里没有的词打对了,不会被凭空加进来', () => {
    recordReviewOutcomes([correct('never-missed')]);
    expect(mistakeCount()).toBe(0);
  });
});

describe('错题本:毕业', () => {
  it(`★ 连着打对 ${GRADUATE_AFTER_CORRECTS} 次就从本子里移走`, () => {
    recordReviewOutcomes([missed('a')]);
    for (let i = 0; i < GRADUATE_AFTER_CORRECTS - 1; i++) {
      recordReviewOutcomes([correct('a')]);
      expect(mistakeCount()).toBe(1); // 还没攒够,仍在本子里
    }
    recordReviewOutcomes([correct('a')]);
    expect(mistakeCount()).toBe(0);
  });

  it('★ 中途又错一次,毕业进度清零重来', () => {
    recordReviewOutcomes([missed('a')]);
    recordReviewOutcomes([correct('a')]);       // streak = 1
    recordReviewOutcomes([missed('a')]);        // 又错了 -> streak 归零
    expect(listMistakes()[0].streak).toBe(0);
    recordReviewOutcomes([correct('a')]);       // streak = 1,还不够
    expect(mistakeCount()).toBe(1);
    recordReviewOutcomes([correct('a')]);       // streak = 2 -> 毕业
    expect(mistakeCount()).toBe(0);
  });

  it('毕业之后再错,会作为新词重新进本子', () => {
    recordReviewOutcomes([missed('a')]);
    for (let i = 0; i < GRADUATE_AFTER_CORRECTS; i++) recordReviewOutcomes([correct('a')]);
    expect(mistakeCount()).toBe(0);
    const added = recordReviewOutcomes([missed('a')]);
    expect(added).toBe(1);
    expect(listMistakes()[0].misses).toBe(1); // 重新计数,不是接着之前的
  });
});

describe('错题本:上限', () => {
  it(`★ 超过 ${MAX_MISTAKES} 条时留下最近打错的,挤掉最旧的`, () => {
    // ★ 必须把每一批的时间戳错开:同一毫秒内写入的条目 lastMissedAt 相同,
    //   排序是稳定的,截断时保留的就是插入顺序而不是「最近」。真实使用中
    //   两局之间隔着几分钟,不会撞在同一毫秒,所以这里用假时钟还原真实情形。
    const realNow = Date.now;
    let clock = 1_000_000;
    Date.now = () => clock;
    try {
      for (let batch = 0; batch < 4; batch++) {
        clock += 60_000; // 每批间隔一分钟,模拟打了四局
        recordReviewOutcomes(Array.from({ length: 100 }, (_, i) => missed(`b${batch}-${i}`)));
      }
    } finally {
      Date.now = realNow;
    }

    expect(mistakeCount()).toBe(MAX_MISTAKES);
    const ids = new Set(listMistakes().map((e) => e.word.id));
    // 最后一批(最新)必须全在
    expect(Array.from({ length: 100 }, (_, i) => `b3-${i}`).every((id) => ids.has(id))).toBe(true);
    // 第一批(最旧)应该已经被挤掉
    expect(ids.has('b0-0')).toBe(false);
  });

  it('一局之内错了超过上限的词:全都同一时刻,截断到上限且不报错', () => {
    // 无限模式一局可能遇到几百个词,这一批的 lastMissedAt 全都相同 ——
    // 这时保留哪些都算「同样新」,只要求不超上限、不炸。
    recordReviewOutcomes(Array.from({ length: MAX_MISTAKES + 50 }, (_, i) => missed(`one-run-${i}`)));
    expect(mistakeCount()).toBe(MAX_MISTAKES);
  });
});

describe('错题本:组词池', () => {
  it('★ 池子里每个词只出现一次 —— 有重复会破坏发词的「一副牌不重复」保证', () => {
    recordReviewOutcomes([missed('a'), missed('b')]);
    recordReviewOutcomes([missed('a'), missed('a')]); // a 错了很多次
    const pool = mistakePool();
    expect(pool.length).toBe(new Set(pool.map((w) => w.id)).size);
    expect(pool.length).toBe(2);
  });

  it('池子里是能直接开打的完整词条(带 typeText)', () => {
    recordReviewOutcomes([missed('a', '铁壁')]);
    const [w] = mistakePool();
    expect(w.typeText).toBe('铁壁');
    expect(w.id).toBe('a');
  });
});

describe('错题本:坏数据', () => {
  it('localStorage 里是坏 JSON 时当空本子处理,不抛错', () => {
    store.set('eorzea:mistakes', '{不是合法 JSON');
    expect(mistakeCount()).toBe(0);
    expect(() => recordReviewOutcomes([missed('a')])).not.toThrow();
    expect(mistakeCount()).toBe(1);
  });

  it('存档里混进形状不对的条目时把坏的丢掉,好的留着', () => {
    store.set('eorzea:mistakes', JSON.stringify([
      { word: word('good', '好词'), misses: 1, streak: 0, lastMissedAt: 1 },
      { nonsense: true },
      { word: { id: 'no-typetext' }, misses: 1, streak: 0, lastMissedAt: 1 },
    ]));
    expect(listMistakes().map((e) => e.word.id)).toEqual(['good']);
  });
});
