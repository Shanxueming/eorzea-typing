import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectPool, isPlayable, buildSequence, pickInterruptWord } from '../src/wordbank';
import { filterFeaturedWordPool } from '../src/battle';
import type { WordBankFile } from '../src/types';

const load = (n: string): WordBankFile =>
  JSON.parse(readFileSync(`${__dirname}/../../../data/wordbanks/${n}.json`, 'utf-8'));

describe('真实词库加载', () => {
  const starter = load('starter');
  const characters = load('characters');

  it('starter 可加载且条目数超过 2000', () => {
    expect(starter.count).toBeGreaterThan(2000);
    expect(starter.entries.length).toBe(starter.count);
  });

  it('每条都有 typeText 与 reading', () => {
    for (const e of starter.entries.slice(0, 500)) {
      expect(e.typeText.length).toBeGreaterThan(0);
      expect(e.reading.length).toBeGreaterThan(0);
    }
  });

  it('pureOnly 筛选后不含非纯汉字条目', () => {
    const pool = selectPool([characters], { categories: ['characters'], pureOnly: true });
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.every((e) => e.pure)).toBe(true);
  });

  it('★ characters 筛选后不含路人 NPC', () => {
    const pool = selectPool([characters], { categories: ['characters'], pureOnly: true });
    expect(pool.every((e) => e.named === true)).toBe(true);
    expect(pool.some((e) => e.text.includes('的'))).toBe(false);
  });

  it('★ 同 seed 下服务端与客户端序列一致', () => {
    const pool = selectPool([starter], { categories: ['starter'], pureOnly: true });
    expect(buildSequence(pool, 80, 'ROOM42')).toEqual(buildSequence(pool, 80, 'ROOM42'));
  });

  it('打断词优先取难度 3', () => {
    const pool = selectPool([starter], { categories: ['starter'], pureOnly: true });
    const w = pickInterruptWord(pool, 'cast-1');
    expect(w).not.toBeNull();
    expect(w!.difficulty).toBe(3);
  });

  it('难度筛选生效', () => {
    const pool = selectPool([starter], {
      categories: ['starter'], pureOnly: true, difficulties: [1],
    });
    expect(pool.every((e) => e.difficulty === 1)).toBe(true);
  });

  it('特色词池只保留有艾欧泽亚标识的道具', () => {
    const items = [
      { id: 'generic', text: '人参', typeText: '人参', reading: 'ren shen', category: 'items', difficulty: 1, pure: true },
      { id: 'lamp', text: '壁灯', typeText: '壁灯', reading: 'bi deng', category: 'items', difficulty: 1, pure: true },
      { id: 'potion', text: '幻想药', typeText: '幻想药', reading: 'huan xiang yao', category: 'items', difficulty: 1, pure: true },
      { id: 'elixir', text: '高级圣灵药', typeText: '高级圣灵药', reading: 'gao ji sheng ling yao', category: 'items', difficulty: 2, pure: true },
      { id: 'food', text: '伊修加德炖菜', typeText: '伊修加德炖菜', reading: 'yi xiu jia de dun cai', category: 'items', difficulty: 2, pure: true },
      { id: 'job', text: '武士', typeText: '武士', reading: 'wu shi', category: 'jobs', difficulty: 1, pure: true },
    ] as const;
    const pool = filterFeaturedWordPool(items);
    expect(pool.map((entry) => entry.id)).toEqual(['potion', 'elixir', 'food', 'job']);
  });
});
