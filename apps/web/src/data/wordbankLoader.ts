/**
 * 词库懒加载。data/wordbanks/*.json 由服务端静态托管(见 apps/server),
 * 前端只在真正需要时 fetch —— items.json 11MB 也只有玩家勾选该分类才会下载。
 */
import type { WordBankFile, WordCategory } from '@eorzea/shared/types';

const bankCache = new Map<string, Promise<WordBankFile>>();

export function loadBank(category: WordCategory | 'starter'): Promise<WordBankFile> {
  let p = bankCache.get(category);
  if (!p) {
    p = fetch(`/wordbanks/${category}.json`).then((r) => {
      if (!r.ok) throw new Error(`wordbank "${category}" 加载失败: ${r.status}`);
      return r.json() as Promise<WordBankFile>;
    });
    bankCache.set(category, p);
  }
  return p;
}

export function loadBanks(categories: readonly WordCategory[]): Promise<WordBankFile[]> {
  return Promise.all(categories.map(loadBank));
}

export interface WordbankIndexEntry {
  category: WordCategory;
  label: string;
  count: number;
  pure: number;
  file: string;
  byDifficulty: Record<string, number>;
}

export interface WordbankIndex {
  total: number;
  starterCount: number;
  source: string;
  categories: WordbankIndexEntry[];
}

let indexPromise: Promise<WordbankIndex> | null = null;

export function loadWordbankIndex(): Promise<WordbankIndex> {
  if (!indexPromise) {
    indexPromise = fetch('/wordbanks/index.json').then((r) => r.json() as Promise<WordbankIndex>);
  }
  return indexPromise;
}
