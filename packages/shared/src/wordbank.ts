/**
 * 词库加载与筛选。
 *
 * 数据在 data/wordbanks/ 下,共 96,828 条,只读。
 *
 * ★ 两条必须遵守的筛选规则:
 *   1. pureOnly 为 true 时只取 pure === true。含数字或罗马数字的词
 *      (如「丰收II」「4星吨」)在中文输入法下要反复切换,体验很差。
 *   2. characters 分类必须额外要求 named === true,否则会抽到
 *      「爽朗的卫兵」「开朗的青年」这类路人 NPC,毫无辨识度。
 *
 * ★ items.json 有 11 MB,禁止 import 进前端 bundle。只允许服务端读取,
 *   或玩家显式勾选该分类时异步 fetch。
 */

import type { WordEntry, WordBankFile, WordCategory } from './types';
import { generateWordSequence } from './rng';

/** 体积过大、不能静态引入的分类 */
export const HEAVY_CATEGORIES: readonly WordCategory[] = ['items'];

export interface SelectOptions {
  categories: readonly WordCategory[];
  pureOnly: boolean;
  /** 只保留指定难度,不传则全要 */
  difficulties?: readonly (1 | 2 | 3)[];
}

/** 单条是否可用 */
export function isPlayable(e: WordEntry, opts: Pick<SelectOptions, 'pureOnly'>): boolean {
  if (opts.pureOnly && !e.pure) return false;
  // characters 分类混有大量路人 NPC,只要具名角色
  if (e.category === 'characters' && e.named !== true) return false;
  return true;
}

/**
 * 从若干词库文件中筛出可用词池。
 * 按 id 去重,因为 places 由 PlaceName 与 TerritoryType 合并而来,可能有重叠。
 */
export function selectPool(
  banks: readonly WordBankFile[],
  opts: SelectOptions,
): WordEntry[] {
  const want = new Set(opts.categories);
  const diff = opts.difficulties ? new Set(opts.difficulties) : null;
  const seen = new Set<string>();
  const out: WordEntry[] = [];

  for (const bank of banks) {
    if (want.size > 0 && !want.has(bank.category as WordCategory)) continue;
    for (const e of bank.entries) {
      if (seen.has(e.id)) continue;
      if (!isPlayable(e, opts)) continue;
      if (diff && !diff.has(e.difficulty)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/**
 * 生成本局词序列。
 * ★ 服务端与客户端用同一个 seed 各自调用本函数,得到完全相同的序列。
 */
export function buildSequence(
  pool: readonly WordEntry[],
  count: number,
  seed: string,
): WordEntry[] {
  return generateWordSequence(pool, count, seed);
}

/**
 * 挑一个打断词。读条阶段用,固定取难度 3 的长词。
 * 池里没有难度 3 时退而求其次取难度 2。
 */
export function pickInterruptWord(
  pool: readonly WordEntry[],
  seed: string,
): WordEntry | null {
  const hard = pool.filter((e) => e.difficulty === 3);
  const mid = pool.filter((e) => e.difficulty === 2);
  const src = hard.length > 0 ? hard : mid.length > 0 ? mid : pool;
  if (src.length === 0) return null;
  return generateWordSequence(src, 1, seed)[0];
}

/** 联机时随机抽 2 到 4 个分类 */
export function randomCategories(
  available: readonly WordCategory[],
  seed: string,
): WordCategory[] {
  const pool = available.filter((c) => !HEAVY_CATEGORIES.includes(c));
  if (pool.length === 0) return ['starter'];
  const shuffled = generateWordSequence(pool, pool.length, seed);
  const uniq = Array.from(new Set(shuffled));
  const n = Math.min(uniq.length, 2 + (shuffled.length % 3));
  return uniq.slice(0, n);
}
