import { describe, it, expect } from 'vitest';
import {
  analyzeSession, computeMetrics, checkAttempt, THRESHOLDS,
} from '../src/anticheat';
import { makeSession, BOT, HUMAN_FAST, HUMAN_NOVICE } from './fixtures';
import type { WordAttempt } from '../src/types';

describe('统计层 analyzeSession', () => {
  it('机器人样本被判定为 rejected', () => {
    const { attempts, elapsedMs } = makeSession(BOT);
    const r = analyzeSession(attempts, elapsedMs);
    expect(r.trustScore).toBeLessThan(THRESHOLDS.TRUST_REJECT);
    expect(r.verdict).toBe('rejected');
    expect(r.flags).toContain('low_rhythm_variance');
    expect(r.flags).toContain('quantized_timing');
  });

  it('真人快手不被误伤', () => {
    const { attempts, elapsedMs } = makeSession(HUMAN_FAST);
    const r = analyzeSession(attempts, elapsedMs);
    expect(r.trustScore).toBeGreaterThanOrEqual(THRESHOLDS.TRUST_VERIFIED);
    expect(r.verdict).toBe('verified');
  });

  it('真人新手不被误伤', () => {
    const { attempts, elapsedMs } = makeSession(HUMAN_NOVICE);
    const r = analyzeSession(attempts, elapsedMs);
    expect(r.trustScore).toBeGreaterThanOrEqual(THRESHOLDS.TRUST_VERIFIED);
    expect(r.verdict).toBe('verified');
  });

  it('样本不足时不做判定,给满分', () => {
    const { attempts, elapsedMs } = makeSession({ ...BOT, words: 1, keysPerWord: 3 });
    const r = analyzeSession(attempts, elapsedMs);
    expect(r.trustScore).toBe(100);
    expect(r.flags).toContain('insufficient_data');
  });

  it('CV 能区分机器人与真人', () => {
    const bot = computeMetrics(makeSession(BOT).attempts, 1);
    const human = computeMetrics(makeSession(HUMAN_FAST).attempts, 1);
    expect(bot.cv).toBeLessThan(THRESHOLDS.CV_MIN);
    expect(human.cv).toBeGreaterThan(0.3);
  });

  it('失焦过多会扣分', () => {
    const s = makeSession({ ...HUMAN_FAST, focusLostMs: 2000 });
    const r = analyzeSession(s.attempts, s.elapsedMs);
    expect(r.flags).toContain('excessive_blur');
  });
});

describe('硬校验 checkAttempt', () => {
  const base: WordAttempt = {
    wordId: 'act_00412',
    startedAt: 1000,
    submittedAt: 2500,
    submitted: '必杀剑九天',
    keystrokes: Array.from({ length: 15 }, (_, i) => ({
      t: 1100 + i * 90, code: 'KeyA', trusted: true, composing: false,
    })),
    backspaces: 1,
    compositionCommits: 5,
    focusLostMs: 0,
  };
  const expected = { wordId: 'act_00412', target: '必杀剑九天' };

  it('正常提交通过', () => {
    expect(checkAttempt(base, expected, 2500).ok).toBe(true);
  });

  it('词 ID 不符被拦截', () => {
    const r = checkAttempt({ ...base, wordId: 'act_99999' }, expected, 2500);
    expect(r.flags).toContain('word_id_mismatch');
  });

  it('非可信事件被拦截', () => {
    const ks = base.keystrokes.map((k, i) => (i === 3 ? { ...k, trusted: false } : k));
    const r = checkAttempt({ ...base, keystrokes: ks }, expected, 2500);
    expect(r.flags).toContain('untrusted_event');
  });

  it('粘贴被拦截:5 个字只按了 1 次键', () => {
    const r = checkAttempt(
      { ...base, keystrokes: [{ t: 1100, code: 'KeyV', trusted: true, composing: false }] },
      expected, 2500,
    );
    expect(r.flags).toContain('keystroke_deficit');
  });

  it('时间倒流被拦截', () => {
    const r = checkAttempt({ ...base, submittedAt: 500 }, expected, 500);
    expect(r.flags).toContain('time_travel');
  });

  it('击键时间戳非单调被拦截', () => {
    const ks = [...base.keystrokes];
    ks[5] = { ...ks[5], t: 1050 };
    const r = checkAttempt({ ...base, keystrokes: ks }, expected, 2500);
    expect(r.flags).toContain('time_travel');
  });

  it('客户端时钟偏差过大被拦截', () => {
    const r = checkAttempt(base, expected, 2500 + THRESHOLDS.CLOCK_SKEW_MS + 1000);
    expect(r.flags).toContain('clock_skew');
  });
});
