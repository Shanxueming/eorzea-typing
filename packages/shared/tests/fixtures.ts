/**
 * 测试夹具:合成击键流。
 *
 * 人类的击键间隔近似对数正态分布,所以这里用对数正态来生成 —— 直接用均匀分布
 * 会造出一个直方图平坦、CV 也对不上的假样本,测不出真东西。
 *
 * 对数正态与 CV 的关系:
 *   CV = sqrt(exp(sigma^2) - 1)   =>   sigma = sqrt(ln(1 + CV^2))
 *   mean = exp(mu + sigma^2/2)    =>   mu = ln(mean) - sigma^2/2
 */

import { createRng } from '../src/rng';
import type { WordAttempt, KeystrokeEvent } from '../src/types';

export interface SessionSpec {
  words: number;
  charsPerWord: number;
  /** 每个词的物理击键数。中文走 IME,一个汉字约 3 次击键 */
  keysPerWord: number;
  meanIki: number;
  /** 变异系数。0 = 完全恒定(机器人) */
  cv: number;
  backspaceRate: number;
  /** 词出现到第一次击键的延迟中位数 */
  firstKeyLatency: number;
  latencyJitter: number;
  /** 词间停顿 */
  wordGap: number;
  focusLostMs?: number;
  trusted?: boolean;
  seed?: string;
}

export interface GeneratedSession {
  attempts: WordAttempt[];
  elapsedMs: number;
}

export function makeSession(spec: SessionSpec): GeneratedSession {
  const rng = createRng(spec.seed ?? 'fixture');
  const sigma = Math.sqrt(Math.log(1 + spec.cv * spec.cv));
  const mu = Math.log(spec.meanIki) - (sigma * sigma) / 2;

  // Box-Muller,取一个标准正态
  const gauss = (): number => {
    const u1 = Math.max(rng.next(), 1e-9);
    const u2 = rng.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const nextIki = (): number =>
    sigma === 0 ? spec.meanIki : Math.max(1, Math.exp(mu + sigma * gauss()));

  const attempts: WordAttempt[] = [];
  let clock = 0;

  for (let w = 0; w < spec.words; w++) {
    const startedAt = clock;
    const jitter = spec.latencyJitter > 0
      ? (rng.next() - 0.5) * 2 * spec.latencyJitter
      : 0;
    let t = startedAt + Math.max(1, spec.firstKeyLatency + jitter);

    const keystrokes: KeystrokeEvent[] = [];
    for (let k = 0; k < spec.keysPerWord; k++) {
      if (k > 0) t += nextIki();
      keystrokes.push({
        t: Math.round(t),
        code: 'KeyA',
        trusted: spec.trusted ?? true,
        composing: false,
      });
    }

    const submittedAt = Math.round(t) + 10;
    attempts.push({
      wordId: `w_${w}`,
      startedAt: Math.round(startedAt),
      submittedAt,
      submitted: 'x'.repeat(spec.charsPerWord),
      keystrokes,
      backspaces: Math.round(spec.keysPerWord * spec.backspaceRate),
      compositionCommits: spec.charsPerWord,
      focusLostMs: spec.focusLostMs ?? 0,
    });

    clock = submittedAt + spec.wordGap;
  }

  return { attempts, elapsedMs: Math.round(clock) };
}

/** 脚本或 AI 代打:间隔恒定、零退格、反应瞬时、准确率 100% */
export const BOT: SessionSpec = {
  words: 40, charsPerWord: 6, keysPerWord: 15,
  meanIki: 30, cv: 0,
  backspaceRate: 0, firstKeyLatency: 50, latencyJitter: 0,
  wordGap: 0, seed: 'bot',
};

/** 真人快手 */
export const HUMAN_FAST: SessionSpec = {
  words: 40, charsPerWord: 5, keysPerWord: 15,
  meanIki: 90, cv: 0.45,
  backspaceRate: 0.04, firstKeyLatency: 300, latencyJitter: 120,
  wordGap: 60, seed: 'fast',
};

/** 真人新手 */
export const HUMAN_NOVICE: SessionSpec = {
  words: 30, charsPerWord: 4, keysPerWord: 12,
  meanIki: 300, cv: 0.8,
  backspaceRate: 0.12, firstKeyLatency: 550, latencyJitter: 250,
  wordGap: 200, seed: 'novice',
};
