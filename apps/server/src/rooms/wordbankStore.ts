/**
 * 服务端自己的词库读取。data/wordbanks/ 只读,权威判定与联机分类抽取都在这里。
 * 大文件(items.json)只有真的被抽中的分类会读,不会一次性加载全部 21 个分类。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WordBankFile, WordCategory } from '@eorzea/shared/types';
import { WORDBANKS_DIR } from '../paths.js';

const bankCache = new Map<string, Promise<WordBankFile>>();

export function loadBank(category: string): Promise<WordBankFile> {
  let p = bankCache.get(category);
  if (!p) {
    p = fs
      .readFile(path.join(WORDBANKS_DIR, `${category}.json`), 'utf8')
      .then((s) => JSON.parse(s) as WordBankFile);
    bankCache.set(category, p);
  }
  return p;
}

export function loadBanks(categories: readonly WordCategory[]): Promise<WordBankFile[]> {
  return Promise.all(categories.map(loadBank));
}

let categoriesPromise: Promise<WordCategory[]> | null = null;

/** 联机随机抽分类要用到的"全部可用分类"列表,来自 index.json,不含 starter */
export function loadAllCategories(): Promise<WordCategory[]> {
  if (!categoriesPromise) {
    categoriesPromise = fs
      .readFile(path.join(WORDBANKS_DIR, 'index.json'), 'utf8')
      .then((s) => JSON.parse(s) as { categories: { category: WordCategory }[] })
      .then((idx) => idx.categories.map((c) => c.category));
  }
  return categoriesPromise;
}
