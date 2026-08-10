/**
 * 判分引擎。全部为无副作用的纯函数。
 *
 * ★ 前端用它做乐观预测,服务端用它做权威判定 —— 同一份代码,两处运行。
 *   不允许在别处再写一份判定逻辑。
 */

import type { WordEntry, WordAttempt, TypingMode } from './types';

// ─────────────────────────── 输入判定 ───────────────────────────

export type JudgeStatus = 'empty' | 'progress' | 'error' | 'complete';

export interface JudgeResult {
  status: JudgeStatus;
  /** 已正确匹配的字符数,用于高亮 */
  matchedLength: number;
  /** 判定目标(hanzi 模式为 typeText,pinyin 模式为去空格的 reading) */
  target: string;
}

/** 取得该词在指定模式下的判定目标 */
export function targetOf(entry: WordEntry, mode: TypingMode = 'hanzi'): string {
  return mode === 'pinyin' ? entry.reading.replace(/\s+/g, '') : entry.typeText;
}

/**
 * 前缀比对判定。
 *
 * ★ 比对的是 typeText 而非 text。界面显示「必杀剑·九天」,玩家只需打
 *   「必杀剑九天」—— 中点在中文输入法下几乎打不出,拿 text 比对会让游戏不可玩。
 *
 * 错误时不清空输入,允许玩家退格纠正。
 */
export function judgeInput(
  entry: WordEntry,
  input: string,
  mode: TypingMode = 'hanzi',
): JudgeResult {
  const target = targetOf(entry, mode);
  const value = mode === 'pinyin' ? input.toLowerCase().trim() : input;

  if (value.length === 0) {
    return { status: 'empty', matchedLength: 0, target };
  }
  if (value === target) {
    return { status: 'complete', matchedLength: target.length, target };
  }
  if (target.startsWith(value)) {
    return { status: 'progress', matchedLength: value.length, target };
  }

  // 错误:算出仍然匹配的公共前缀长度,便于高亮到出错的位置
  let matched = 0;
  const max = Math.min(value.length, target.length);
  while (matched < max && value[matched] === target[matched]) matched++;
  return { status: 'error', matchedLength: matched, target };
}

// ─────────────────────────── 伤害与连击 ───────────────────────────

export const COMBO_STEP = 0.1;
export const COMBO_MAX_MULTIPLIER = 3;
export const BASE_DAMAGE_PER_DIFFICULTY = 100;
/** 打断成功的额外伤害倍率 */
export const INTERRUPT_BONUS = 2.5;

export function comboMultiplier(combo: number): number {
  return Math.min(1 + combo * COMBO_STEP, COMBO_MAX_MULTIPLIER);
}

export function computeDamage(
  difficulty: 1 | 2 | 3,
  combo: number,
  isInterrupt = false,
): number {
  const base = difficulty * BASE_DAMAGE_PER_DIFFICULTY;
  const dmg = base * comboMultiplier(combo) * (isInterrupt ? INTERRUPT_BONUS : 1);
  return Math.round(dmg);
}

// ─────────────────────────── 统计 ───────────────────────────

export interface SessionStats {
  wordsCompleted: number;
  misses: number;
  /** 0..1 */
  accuracy: number;
  /** 字符每分钟 */
  cpm: number;
  /** 词每分钟,按 5 字符 = 1 词的行业惯例折算 */
  wpm: number;
  totalKeystrokes: number;
  totalBackspaces: number;
  elapsedMs: number;
}

/**
 * 从 attempt 序列算出本局统计。
 *
 * 注意 accuracy 用击键口径而非词口径:总击键中有多少不是退格。
 * 词口径会让一个词里改三次和改一次看起来一样,区分度太低。
 *
 * ★ 2026-08-08:新增 nonTypingMs——泰坦之怒/三连桶/三穿一这类机制进行期间,
 *   玩家在处理机制挑战而不是打普通词,这段时间(尤其是打断失败,完全不产生
 *   任何 attempt)算进 CPM 的分母只会把"打字速度"这个指标拖得虚低,机制越多
 *   越明显。调用方把这段时间累加后传进来,从分母里扣掉;elapsedMs 本身
 *   (给"本局时长"这类展示用)不受影响,还是整局真实时长。
 */
export function computeStats(
  attempts: readonly WordAttempt[],
  elapsedMs: number,
  mode: TypingMode = 'hanzi',
  targets?: ReadonlyMap<string, string>,
  nonTypingMs = 0,
): SessionStats {
  let completed = 0;
  let misses = 0;
  let keystrokes = 0;
  let backspaces = 0;
  let chars = 0;

  for (const a of attempts) {
    keystrokes += a.keystrokes.length;
    backspaces += a.backspaces;
    const expected = targets?.get(a.wordId);
    const ok = expected === undefined ? a.submitted.length > 0 : a.submitted === expected;
    if (ok) {
      completed++;
      chars += a.submitted.length;
    } else {
      misses++;
    }
  }

  const typingMs = Math.max(0, elapsedMs - nonTypingMs);
  const minutes = typingMs / 60000;
  const cpm = minutes > 0 ? chars / minutes : 0;
  // pinyin 模式按字母计,hanzi 模式按汉字计;WPM 统一用 5 字符 = 1 词折算
  const wpm = cpm / 5;
  const accuracy = keystrokes > 0 ? Math.max(0, (keystrokes - backspaces) / keystrokes) : 1;

  return {
    wordsCompleted: completed,
    misses,
    accuracy: Number(accuracy.toFixed(4)),
    cpm: Math.round(cpm),
    wpm: Math.round(wpm),
    totalKeystrokes: keystrokes,
    totalBackspaces: backspaces,
    elapsedMs,
  };
}

export function computeScore(
  damage: number,
  interruptsSucceeded: number,
  accuracy: number,
): number {
  return Math.round(damage + interruptsSucceeded * 500 + accuracy * 1000);
}
