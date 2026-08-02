import { describe, it, expect } from 'vitest';
import { judgeInput, targetOf, computeDamage, comboMultiplier, computeStats } from '../src/scoring';
import { createRng, generateWordSequence, hashSeed } from '../src/rng';
import { MAX_INTERRUPT_WORD_LENGTH, pickShortInterruptWord } from '../src/battle';
import type { WordEntry } from '../src/types';

const 九天: WordEntry = {
  id: 'act_00412',
  text: '必杀剑·九天',
  typeText: '必杀剑九天',
  reading: 'bi sha jian jiu tian',
  category: 'actions',
  difficulty: 2,
  pure: false,
};

const 铁壁: WordEntry = {
  id: 'act_00010', text: '铁壁', typeText: '铁壁', reading: 'tie bi',
  category: 'actions', difficulty: 1, pure: true,
};

describe('judgeInput 判定 typeText 而非 text', () => {
  it('★ 带中点的词:打不带中点的文本即通过', () => {
    expect(judgeInput(九天, '必杀剑九天').status).toBe('complete');
  });

  it('★ 打成显示原文(带中点)反而不算完成', () => {
    expect(judgeInput(九天, '必杀剑·九天').status).toBe('error');
  });

  it('前缀正确时为进行中,并给出已匹配长度', () => {
    const r = judgeInput(九天, '必杀剑');
    expect(r.status).toBe('progress');
    expect(r.matchedLength).toBe(3);
  });

  it('前缀错误时为 error,且保留公共前缀长度供高亮', () => {
    const r = judgeInput(九天, '必杀刀');
    expect(r.status).toBe('error');
    expect(r.matchedLength).toBe(2);
  });

  it('空输入为 empty', () => {
    expect(judgeInput(铁壁, '').status).toBe('empty');
  });

  it('拼音模式比对去空格的 reading,且大小写不敏感', () => {
    expect(targetOf(九天, 'pinyin')).toBe('bishajianjiutian');
    expect(judgeInput(九天, 'BiShaJianJiuTian', 'pinyin').status).toBe('complete');
    expect(judgeInput(九天, 'bisha', 'pinyin').status).toBe('progress');
  });
});

describe('伤害与连击', () => {
  it('连击提升倍率并封顶', () => {
    expect(comboMultiplier(0)).toBe(1);
    expect(comboMultiplier(10)).toBeCloseTo(2);
    expect(comboMultiplier(999)).toBe(3);
  });

  it('难度与连击共同决定伤害', () => {
    expect(computeDamage(1, 0)).toBe(100);
    expect(computeDamage(3, 0)).toBe(300);
    expect(computeDamage(2, 10)).toBe(400);
  });

  it('打断有额外倍率', () => {
    expect(computeDamage(3, 0, true)).toBeGreaterThan(computeDamage(3, 0));
  });
});

describe('computeStats', () => {
  it('准确率按击键口径计算', () => {
    const mk = (keys: number, back: number) => ({
      wordId: 'w', startedAt: 0, submittedAt: 100, submitted: '铁壁',
      keystrokes: Array.from({ length: keys }, (_, i) => ({
        t: i * 10, code: 'KeyA', trusted: true, composing: false,
      })),
      backspaces: back, compositionCommits: 2, focusLostMs: 0,
    });
    const s = computeStats([mk(10, 1), mk(10, 1)], 60000);
    expect(s.totalKeystrokes).toBe(20);
    expect(s.accuracy).toBeCloseTo(0.9);
    expect(s.wordsCompleted).toBe(2);
  });
});

describe('rng 可复现性', () => {
  it('同 seed 产生完全相同的序列', () => {
    const a = createRng('eorzea');
    const b = createRng('eorzea');
    const xs = Array.from({ length: 200 }, () => a.next());
    const ys = Array.from({ length: 200 }, () => b.next());
    expect(xs).toEqual(ys);
  });

  it('不同 seed 产生不同序列', () => {
    expect(createRng('a').next()).not.toBe(createRng('b').next());
  });

  it('★ 服务端与客户端能独立生成同一条词序列', () => {
    const pool = ['铁壁', '先锋剑', '狂怒剑', '渐愈', '深仁厚泽'];
    const client = generateWordSequence(pool, 50, 'room-ABC123');
    const server = generateWordSequence(pool, 50, 'room-ABC123');
    expect(client).toEqual(server);
  });

  it('洗牌保证一轮内不重复', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    const seq = generateWordSequence(pool, 5, 's');
    expect(new Set(seq).size).toBe(5);
  });

  it('int 与 range 落在边界内', () => {
    const r = createRng('bounds');
    for (let i = 0; i < 500; i++) {
      const v = r.int(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      const w = r.range(3, 5);
      expect(w).toBeGreaterThanOrEqual(3);
      expect(w).toBeLessThanOrEqual(5);
    }
  });

  it('hashSeed 稳定且为无符号 32 位', () => {
    expect(hashSeed('x')).toBe(hashSeed('x'));
    expect(hashSeed('room-1')).toBeGreaterThanOrEqual(0);
  });
});

describe('泰坦之怒短词筛选', () => {
  it('只会选 typeText 不超过四个字符的词，即使长词难度更高也不会回退', () => {
    const short = { ...铁壁, id: 'short', typeText: '四字挑战', difficulty: 1 as const };
    const long = { ...九天, id: 'long', typeText: '五个字以上', difficulty: 3 as const };
    const picked = pickShortInterruptWord([long, short], 'titan-short');
    expect(picked?.id).toBe('short');
    expect(picked?.typeText.length).toBeLessThanOrEqual(MAX_INTERRUPT_WORD_LENGTH);
  });

  it('没有四字及以下词时不触发泰坦之怒', () => {
    const long = { ...九天, id: 'only-long', typeText: '五个字以上', difficulty: 3 as const };
    expect(pickShortInterruptWord([long], 'titan-none')).toBeNull();
  });
});
