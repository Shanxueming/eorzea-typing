/**
 * 错题本:把你打错过的词攒起来,可以单独拉出来练。
 *
 * ★ 存在 localStorage 而不是服务端,理由有三条:
 *   1. 不登录也能用 —— 错题本是给自己练的,不是成绩,没必要绑账号;
 *   2. 打完一局立刻要能看到,不该为它多一次网络往返、更不该因为网络失败丢数据;
 *   3. 它天然是「这台机器上这个人」的东西,跨设备同步的价值远低于实现成本。
 *   服务端那份 7 天存档(play_sessions)解决的是另一个问题(成绩找回),两者不冲突。
 *
 * ★ 会「毕业」:一个词后来又连着打对 GRADUATE_AFTER_CORRECTS 次就从本子里移走。
 *   不然错题本只增不减,练到最后全是早就会了的词,反而失去针对性。
 */
import type { WordEntry } from '@eorzea/shared/types';
import type { WordReviewEntry } from '../scenes/SoloBattle';

const STORAGE_KEY = 'eorzea:mistakes';
/** 之后连着打对几次就从错题本里移走 */
export const GRADUATE_AFTER_CORRECTS = 2;
/**
 * 错题本最多留多少词。超了就把「最久没再打错的」挤掉 ——
 * 不封顶的话 localStorage 会被慢慢撑爆,而且太老的错题也没有练的必要了。
 */
export const MAX_MISTAKES = 300;
/** 少于这个数就不给开练习局:词太少一轮下来全是重复的,没意义 */
export const MIN_PRACTICE_WORDS = 5;

export interface MistakeEntry {
  word: WordEntry;
  /** 一共打错过几次 */
  misses: number;
  /** 上次打错之后又连着打对了几次,攒够 GRADUATE_AFTER_CORRECTS 就毕业 */
  streak: number;
  lastMissedAt: number;
}

function read(): MistakeEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 存档结构变过/被手改过都可能读出脏数据,逐条挑出形状对的,坏的直接丢掉
    return parsed.filter((e): e is MistakeEntry => {
      const m = e as Partial<MistakeEntry>;
      return !!m && typeof m.misses === 'number' && !!m.word && typeof m.word.id === 'string'
        && typeof m.word.typeText === 'string';
    });
  } catch {
    return [];
  }
}

function write(list: MistakeEntry[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 无痕模式/存储满了 —— 错题本丢了不影响玩,不打扰玩家
  }
}

/**
 * 把一局的复盘结果并进错题本:打错的加进来(或加次数),打对的攒毕业进度。
 * @returns 这一局新记进来的错词数,给结算页提示用
 */
export function recordReviewOutcomes(review: readonly WordReviewEntry[]): number {
  if (review.length === 0) return 0;
  const list = read();
  const byId = new Map(list.map((e) => [e.word.id, e]));
  let added = 0;

  for (const r of review) {
    // WordReviewEntry 就是 WordEntry + outcome,把 outcome 摘掉就是干净的词条
    const { outcome, ...word } = r;
    const existing = byId.get(word.id);
    if (outcome === 'missed') {
      if (existing) {
        existing.misses += 1;
        existing.streak = 0; // 又错了,毕业进度清零
        existing.lastMissedAt = Date.now();
      } else {
        const entry: MistakeEntry = { word, misses: 1, streak: 0, lastMissedAt: Date.now() };
        byId.set(word.id, entry);
        list.push(entry);
        added += 1;
      }
    } else if (existing) {
      existing.streak += 1;
      if (existing.streak >= GRADUATE_AFTER_CORRECTS) byId.delete(word.id);
    }
  }

  // byId 里被 delete 掉的是毕业的,过滤掉;再按「最近打错的排前面」截断
  let next = list.filter((e) => byId.has(e.word.id));
  next.sort((a, b) => b.lastMissedAt - a.lastMissedAt);
  if (next.length > MAX_MISTAKES) next = next.slice(0, MAX_MISTAKES);
  write(next);
  return added;
}

/** 错题本里现在有多少词 */
export function mistakeCount(): number {
  return read().length;
}

/** 错题本全文,按「最近打错的排前面」 */
export function listMistakes(): MistakeEntry[] {
  return read().sort((a, b) => b.lastMissedAt - a.lastMissedAt);
}

/**
 * 拿错题本组一个可以直接开打的词池。
 *
 * ★ 刻意**不按打错次数加权**(不把错得多的词重复塞进池子):createWordQueue
 *   是牌堆式发词,靠「一副牌里每个词只有一张」来保证不重复。池子里放重复词条
 *   会让同一个词在一副牌内就相邻出现两次,看起来正是之前修掉的那个
 *   「高频重复词」bug。错题本本来就不大,发完一轮自然会再遇到,不需要加权。
 */
export function mistakePool(): WordEntry[] {
  return listMistakes().map((e) => e.word);
}

export function clearMistakes(): void {
  write([]);
}
