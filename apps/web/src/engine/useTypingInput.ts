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

import { useCallback, useEffect, useRef, useReducer } from 'react';
import type { KeystrokeEvent, WordEntry, TypingMode } from '@eorzea/shared/types';
import {
  typingReducer, initialTypingState, type TypingState,
} from '@eorzea/shared/typingReducer';

// ───────────────────────── React hook ─────────────────────────

export interface UseTypingInputOptions {
  entry: WordEntry | null;
  mode: TypingMode;
  /** 返回相对本局开始的毫秒数 */
  now: () => number;
  /** 一个词打完时回调,拿到该词的完整遥测 */
  onComplete: (payload: {
    submitted: string;
    keystrokes: KeystrokeEvent[];
    backspaces: number;
    compositionCommits: number;
    focusLostMs: number;
    startedAt: number;
    submittedAt: number;
  }) => void;
  disabled?: boolean;
}

export function useTypingInput(opts: UseTypingInputOptions) {
  const { entry, mode, now, onComplete, disabled } = opts;
  const [state, dispatch] = useReducer(typingReducer, undefined, () => initialTypingState(0));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // 换词时重置。注意依赖是 entry?.id 而不是 entry 对象,避免引用变化导致误重置
  useEffect(() => {
    dispatch({ type: 'RESET', now: now() });
    if (inputRef.current) inputRef.current.value = '';
  }, [entry?.id]);

  // 打完一个词:上报遥测并清空
  useEffect(() => {
    if (state.status !== 'complete' || !entry) return;
    onComplete({
      submitted: state.input,
      keystrokes: state.keystrokes,
      backspaces: state.backspaces,
      compositionCommits: state.compositionCommits,
      focusLostMs: state.focusLostMs,
      startedAt: state.wordStartedAt,
      submittedAt: now(),
    });
    if (inputRef.current) inputRef.current.value = '';
  }, [state.status]);

  const handleKeyDown = useCallback((ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    // 双重兜底:原生事件的 isComposing,加上 reducer 里维护的标志位
    const composing = ev.nativeEvent.isComposing || stateRef.current.isComposing;
    dispatch({
      type: 'KEYDOWN',
      code: ev.code || ev.key,
      trusted: ev.nativeEvent.isTrusted,
      composing,
      now: now(),
    });
  }, [disabled, now]);

  const handleInput = useCallback((ev: React.FormEvent<HTMLInputElement>) => {
    if (disabled || !entry) return;
    dispatch({ type: 'INPUT', value: ev.currentTarget.value, entry, mode });
  }, [disabled, entry, mode]);

  const handleCompositionStart = useCallback(() => {
    dispatch({ type: 'COMPOSITION_START' });
  }, []);

  const handleCompositionEnd = useCallback((ev: React.CompositionEvent<HTMLInputElement>) => {
    if (!entry) return;
    dispatch({
      type: 'COMPOSITION_END',
      value: (ev.target as HTMLInputElement).value,
      entry,
      mode,
    });
  }, [entry, mode]);

  const handleBlur = useCallback(() => dispatch({ type: 'BLUR', now: now() }), [now]);
  const handleFocus = useCallback(() => dispatch({ type: 'FOCUS', now: now() }), [now]);
  const reset = useCallback(() => {
    // 重输同一词时只清输入，不重置该词的限时起点；换词仍由上面的 entry effect 重置。
    dispatch({ type: 'RESET', now: stateRef.current.wordStartedAt });
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  return {
    state,
    inputRef,
    reset,
    inputProps: {
      ref: inputRef,
      onKeyDown: handleKeyDown,
      onInput: handleInput,
      onCompositionStart: handleCompositionStart,
      onCompositionEnd: handleCompositionEnd,
      onBlur: handleBlur,
      onFocus: handleFocus,
      autoComplete: 'off' as const,
      autoCorrect: 'off' as const,
      spellCheck: false,
      disabled,
    },
  };
}
