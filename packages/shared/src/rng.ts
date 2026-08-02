/**
 * seed 驱动的可复现伪随机数。
 *
 * ★ 这是联机的地基:服务端与客户端用同一个 seed 独立生成同一条词序列,
 *   既免除逐词往返的延迟,又杜绝客户端伪造词序。
 *
 * 因此本文件的算法一旦上线就不能随意改动 —— 任何改动都会让历史回放失效。
 * 若必须改,请提升 RNG_VERSION 并在 seed 里带上版本号。
 */

export const RNG_VERSION = 1;

/** 把任意字符串散列成 32 位无符号整数(xmur3) */
export function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [0, n) 的整数 */
  int(n: number): number;
  pick<T>(arr: readonly T[]): T;
  /** [min, max] 的整数 */
  range(min: number, max: number): number;
}

/** mulberry32 —— 小而快,分布够用,跨平台结果一致 */
export function createRng(seed: string | number): Rng {
  let a = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (n: number): number => Math.floor(next() * n);

  return {
    next,
    int,
    pick: <T,>(arr: readonly T[]): T => arr[int(arr.length)],
    range: (min: number, max: number): number => min + int(max - min + 1),
  };
}

/**
 * 从词池中生成一条长度为 count 的词序列。
 *
 * 采用「洗牌后顺序取,取完再洗」的策略,保证短期内不重复出现同一个词,
 * 比每次独立随机抽取的体验好得多。
 */
export function generateWordSequence<T>(
  pool: readonly T[],
  count: number,
  seed: string,
): T[] {
  if (pool.length === 0) return [];
  const rng = createRng(seed);
  const out: T[] = [];
  let bag: T[] = [];

  while (out.length < count) {
    if (bag.length === 0) {
      bag = pool.slice();
      // Fisher-Yates
      for (let i = bag.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    out.push(bag.pop() as T);
  }
  return out;
}
