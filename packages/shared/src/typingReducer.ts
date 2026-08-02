/**
 * IME 安全的打字输入。
 *
 * ★★★ 这是全项目最高风险的文件。中文输入法在拼音上屏前会经历一个「合成态」,
 *     此期间输入框里是拼音串而非汉字。若在合成期间判定,玩家每打一个字都会被判错,
 *     游戏对中文玩家直接不可用。
 *
 * 处理要点:
 *   1. compositionstart / compositionend 维护 isComposing
 *   2. 合成期间不判定,只累计击键遥测
 *   3. keydown 里同时检查 event.isComposing —— Safari 有 keyCode 229 的历史问题,
 *      需要事件与标志位双重兜底
 *   4. 击键遥测记录的是物理按键(keydown),不是上屏字符。
 *      这样中文玩家的节奏数据依然真实,反作弊才有判别依据。
 *
 * 判定逻辑抽成了下面的纯 reducer,可单独测试,不依赖 DOM。
 */

import type { KeystrokeEvent, WordEntry, TypingMode } from './types';
import { judgeInput, type JudgeStatus } from './scoring';

// ───────────────────────── 纯 reducer ─────────────────────────

export interface TypingState {
  input: string;
  isComposing: boolean;
  status: JudgeStatus;
  matchedLength: number;
  keystrokes: KeystrokeEvent[];
  backspaces: number;
  compositionCommits: number;
  focusLostMs: number;
  blurredAt: number | null;
  wordStartedAt: number;
}

export type TypingEvent =
  | { type: 'RESET'; now: number }
  | { type: 'COMPOSITION_START' }
  | { type: 'COMPOSITION_END'; value: string; entry: WordEntry; mode: TypingMode }
  | { type: 'INPUT'; value: string; entry: WordEntry; mode: TypingMode }
  | { type: 'KEYDOWN'; code: string; trusted: boolean; composing: boolean; now: number }
  | { type: 'BLUR'; now: number }
  | { type: 'FOCUS'; now: number };

export function initialTypingState(now = 0): TypingState {
  return {
    input: '',
    isComposing: false,
    status: 'empty',
    matchedLength: 0,
    keystrokes: [],
    backspaces: 0,
    compositionCommits: 0,
    focusLostMs: 0,
    blurredAt: null,
    wordStartedAt: now,
  };
}

export function typingReducer(s: TypingState, e: TypingEvent): TypingState {
  switch (e.type) {
    case 'RESET':
      return initialTypingState(e.now);

    case 'COMPOSITION_START':
      // 进入合成态。此后到 COMPOSITION_END 之间的 INPUT 一律不判定。
      return { ...s, isComposing: true };

    case 'COMPOSITION_END': {
      const r = judgeInput(e.entry, e.value, e.mode);
      return {
        ...s,
        isComposing: false,
        input: e.value,
        status: r.status,
        matchedLength: r.matchedLength,
        compositionCommits: s.compositionCommits + 1,
      };
    }

    case 'INPUT': {
      // ★ 合成期间只记录文本,绝不判定
      if (s.isComposing) {
        return { ...s, input: e.value };
      }
      const r = judgeInput(e.entry, e.value, e.mode);
      return { ...s, input: e.value, status: r.status, matchedLength: r.matchedLength };
    }

    case 'KEYDOWN': {
      const isBackspace = e.code === 'Backspace';
      return {
        ...s,
        backspaces: s.backspaces + (isBackspace ? 1 : 0),
        keystrokes: [
          ...s.keystrokes,
          { t: e.now, code: e.code, trusted: e.trusted, composing: e.composing },
        ],
      };
    }

    case 'BLUR':
      return s.blurredAt === null ? { ...s, blurredAt: e.now } : s;

    case 'FOCUS':
      return s.blurredAt === null
        ? s
        : { ...s, focusLostMs: s.focusLostMs + (e.now - s.blurredAt), blurredAt: null };

    default:
      return s;
  }
}
