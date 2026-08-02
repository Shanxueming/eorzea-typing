/**
 * 反作弊。全部为无副作用的纯函数,由服务端调用。
 *
 * 两层结构:
 *   第一层 checkAttempt   —— 一致性硬校验,命中即该次 attempt 计 0 分
 *   第二层 analyzeSession —— 击键节奏统计,产出 0..100 的 trustScore
 *
 * ★ 为什么统计层能抓脚本与 AI 代打:
 *   程序化输入的击键间隔方差趋近于零、零退格、首键延迟恒定、准确率 100%。
 *   人类打字天然有「词内快、词间慢、偶尔卡壳」的结构。
 *   变异系数(CV)与直方图峰度是其中最强的两个判别器。
 *
 * ★ 阈值全部集中在下面的 THRESHOLDS 里,便于上线后热调。宁松勿紧 ——
 *   误伤一个真人的代价,远高于放过一个刷分的。
 */

import type { WordAttempt } from './types';

export const THRESHOLDS = {
  /** 击键间隔变异系数下限。人类通常 0.35~0.9,脚本趋近 0 */
  CV_MIN: 0.18,
  CV_PENALTY: 40,

  /** 超人手速:低于此间隔的击键占比过高 */
  LOW_IKI_MS: 25,
  LOW_IKI_RATIO: 0.3,
  LOW_IKI_PENALTY: 30,

  /** 长时间零退格。人类退格率通常 2%~10% */
  ZERO_BACKSPACE_MIN_WORDS: 25,
  ZERO_BACKSPACE_PENALTY: 20,

  /** 首键延迟中位数。人类需要读题,通常 180~700ms */
  FIRST_KEY_LATENCY_MS: 120,
  FIRST_KEY_PENALTY: 25,

  /** 高准确率 + 高速度的组合 */
  SUPERHUMAN_ACCURACY: 0.995,
  SUPERHUMAN_CPM: 700,
  SUPERHUMAN_PENALTY: 30,

  /** 页面失焦时长占比 */
  FOCUS_LOST_RATIO: 0.05,
  FOCUS_LOST_PENALTY: 15,

  /** 间隔直方图峰度:多少比例的间隔挤在同一个桶里 */
  HISTOGRAM_BUCKET_MS: 5,
  HISTOGRAM_PEAK_RATIO: 0.6,
  HISTOGRAM_PENALTY: 40,

  /** 客户端时间与服务端墙钟的最大容许偏差 */
  CLOCK_SKEW_MS: 3000,

  /** 每个字符至少需要多少次物理击键。低于此值判为粘贴 */
  MIN_KEYSTROKES_PER_CHAR: 0.5,

  /** 样本不足时不做统计判定,避免误伤短局 */
  MIN_SAMPLE_IKI: 20,

  /** 分档 */
  TRUST_VERIFIED: 70,
  TRUST_REJECT: 40,
} as const;

// ─────────────────────── 第一层:一致性硬校验 ───────────────────────

export type HardFlag =
  | 'word_id_mismatch'
  | 'untrusted_event'
  | 'time_travel'
  | 'clock_skew'
  | 'keystroke_deficit';

export interface AttemptCheck {
  ok: boolean;
  flags: HardFlag[];
}

export interface ExpectedWord {
  wordId: string;
  /** 该词的判定文本,用于核对提交内容 */
  target: string;
}

/**
 * 校验单次提交的一致性。
 *
 * serverElapsedMs 是服务端自本局开始起算的墙钟毫秒数,
 * 用于发现客户端伪造时间戳。
 */
export function checkAttempt(
  attempt: WordAttempt,
  expected: ExpectedWord,
  serverElapsedMs: number,
): AttemptCheck {
  const flags: HardFlag[] = [];

  if (attempt.wordId !== expected.wordId) {
    flags.push('word_id_mismatch');
  }

  if (attempt.keystrokes.some((k) => !k.trusted)) {
    flags.push('untrusted_event');
  }

  // 时间必须前进,且击键必须落在本词的时间窗内
  let timeTravel = attempt.submittedAt <= attempt.startedAt;
  let prev = -Infinity;
  for (const k of attempt.keystrokes) {
    if (k.t < prev) { timeTravel = true; break; }
    if (k.t < attempt.startedAt || k.t > attempt.submittedAt) { timeTravel = true; break; }
    prev = k.t;
  }
  if (timeTravel) flags.push('time_travel');

  if (Math.abs(attempt.submittedAt - serverElapsedMs) > THRESHOLDS.CLOCK_SKEW_MS) {
    flags.push('clock_skew');
  }

  // 粘贴检测:6 个字只按了 1 次键是不可能的
  const needed = attempt.submitted.length * THRESHOLDS.MIN_KEYSTROKES_PER_CHAR;
  if (attempt.submitted.length > 0 && attempt.keystrokes.length < needed) {
    flags.push('keystroke_deficit');
  }

  return { ok: flags.length === 0, flags };
}

// ─────────────────────── 第二层:行为统计 ───────────────────────

export interface SessionMetrics {
  /** 击键间隔的变异系数 */
  cv: number;
  meanIki: number;
  /** 低于 LOW_IKI_MS 的间隔占比 */
  lowIkiRatio: number;
  backspaceRate: number;
  firstKeyLatencyMedian: number;
  accuracy: number;
  cpm: number;
  focusLostRatio: number;
  /** 最大直方图桶的占比 */
  histogramPeakRatio: number;
  sampleSize: number;
}

export interface TrustReport {
  /** 0..100 */
  trustScore: number;
  flags: string[];
  metrics: SessionMetrics;
  /** trustScore 分档后的结论 */
  verdict: 'verified' | 'unverified' | 'rejected';
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 提取所有词内的击键间隔。不跨词,因为词间停顿是读题时间,噪声大 */
export function extractIki(attempts: readonly WordAttempt[]): number[] {
  const out: number[] = [];
  for (const a of attempts) {
    for (let i = 1; i < a.keystrokes.length; i++) {
      const dt = a.keystrokes[i].t - a.keystrokes[i - 1].t;
      if (dt >= 0) out.push(dt);
    }
  }
  return out;
}

export function computeMetrics(
  attempts: readonly WordAttempt[],
  elapsedMs: number,
): SessionMetrics {
  const iki = extractIki(attempts);
  const n = iki.length;

  const mean = n > 0 ? iki.reduce((s, x) => s + x, 0) / n : 0;
  const variance = n > 1
    ? iki.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
    : 0;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

  const lowIkiRatio = n > 0
    ? iki.filter((x) => x < THRESHOLDS.LOW_IKI_MS).length / n
    : 0;

  // 5ms 分桶,找出最高的那个桶占多大比例
  const buckets = new Map<number, number>();
  for (const x of iki) {
    const b = Math.floor(x / THRESHOLDS.HISTOGRAM_BUCKET_MS);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  let peak = 0;
  for (const c of buckets.values()) if (c > peak) peak = c;
  const histogramPeakRatio = n > 0 ? peak / n : 0;

  let keystrokes = 0;
  let backspaces = 0;
  let chars = 0;
  let focusLost = 0;
  const latencies: number[] = [];

  for (const a of attempts) {
    keystrokes += a.keystrokes.length;
    backspaces += a.backspaces;
    chars += a.submitted.length;
    focusLost += a.focusLostMs;
    if (a.keystrokes.length > 0) {
      latencies.push(a.keystrokes[0].t - a.startedAt);
    }
  }

  const accuracy = keystrokes > 0
    ? Math.max(0, (keystrokes - backspaces) / keystrokes)
    : 1;
  const minutes = elapsedMs / 60000;

  return {
    cv,
    meanIki: mean,
    lowIkiRatio,
    backspaceRate: keystrokes > 0 ? backspaces / keystrokes : 0,
    firstKeyLatencyMedian: median(latencies),
    accuracy,
    cpm: minutes > 0 ? chars / minutes : 0,
    focusLostRatio: elapsedMs > 0 ? focusLost / elapsedMs : 0,
    histogramPeakRatio,
    sampleSize: n,
  };
}

export function analyzeSession(
  attempts: readonly WordAttempt[],
  elapsedMs: number,
): TrustReport {
  const m = computeMetrics(attempts, elapsedMs);
  const flags: string[] = [];
  let penalty = 0;

  const add = (flag: string, p: number) => { flags.push(flag); penalty += p; };

  // 样本太少不做统计判定,直接给满分。短局误伤的代价比漏判高得多。
  if (m.sampleSize < THRESHOLDS.MIN_SAMPLE_IKI) {
    return {
      trustScore: 100,
      flags: ['insufficient_data'],
      metrics: m,
      verdict: 'verified',
    };
  }

  if (m.cv < THRESHOLDS.CV_MIN) {
    add('low_rhythm_variance', THRESHOLDS.CV_PENALTY);
  }
  if (m.lowIkiRatio > THRESHOLDS.LOW_IKI_RATIO) {
    add('superhuman_key_rate', THRESHOLDS.LOW_IKI_PENALTY);
  }
  if (m.backspaceRate === 0 && attempts.length > THRESHOLDS.ZERO_BACKSPACE_MIN_WORDS) {
    add('zero_corrections', THRESHOLDS.ZERO_BACKSPACE_PENALTY);
  }
  if (m.firstKeyLatencyMedian < THRESHOLDS.FIRST_KEY_LATENCY_MS) {
    add('instant_reaction', THRESHOLDS.FIRST_KEY_PENALTY);
  }
  if (m.accuracy > THRESHOLDS.SUPERHUMAN_ACCURACY && m.cpm > THRESHOLDS.SUPERHUMAN_CPM) {
    add('superhuman_precision', THRESHOLDS.SUPERHUMAN_PENALTY);
  }
  if (m.focusLostRatio > THRESHOLDS.FOCUS_LOST_RATIO) {
    add('excessive_blur', THRESHOLDS.FOCUS_LOST_PENALTY);
  }
  if (m.histogramPeakRatio > THRESHOLDS.HISTOGRAM_PEAK_RATIO) {
    add('quantized_timing', THRESHOLDS.HISTOGRAM_PENALTY);
  }

  const trustScore = Math.max(0, Math.min(100, 100 - penalty));
  const verdict = trustScore >= THRESHOLDS.TRUST_VERIFIED
    ? 'verified'
    : trustScore >= THRESHOLDS.TRUST_REJECT
      ? 'unverified'
      : 'rejected';

  return { trustScore, flags, metrics: m, verdict };
}
