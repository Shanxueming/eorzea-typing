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

import { useCallback, useEffect, useMemo, useRef, useReducer } from 'react';
import type { KeystrokeEvent, WordEntry, TypingMode } from '@eorzea/shared/types';
import { judgeInput } from '@eorzea/shared/scoring';
import {
  typingReducer, initialTypingState, type TypingState,
} from '@eorzea/shared/typingReducer';

// ───────────────────────── React hook ─────────────────────────

export interface UseTypingInputOptions {
  entry: WordEntry | null;
  /**
   * 备选目标。三连桶那种「同时给左右两个词、打哪个都行」的机制会用到:
   * 传进来之后,输入匹配其中任何一个都算数,`onComplete` 会告诉你命中的是哪个。
   * 不传就是单目标,行为和以前一模一样。
   */
  candidates?: readonly WordEntry[];
  mode: TypingMode;
  /** 返回相对本局开始的毫秒数 */
  now: () => number;
  /** 一个词打完时回调,拿到该词的完整遥测 */
  onComplete: (payload: {
    /** 实际命中的那个词的 id —— 多候选时调用方靠它区分玩家选了哪个 */
    wordId: string;
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

/**
 * 多候选下选出「当前应该拿哪个词去判定」。
 *
 * ★ 只读的 typingReducer 一次只认一个 entry,所以多目标不能靠改 reducer 实现,
 *   而是在 dispatch 之前先挑出最贴合当前输入的那个候选喂给它:
 *   完全命中 > 还是前缀(打了一半) > 都不是(随便给第一个,让它判 error)。
 *   这样「打左词还是右词」在玩家敲第一个字时就自然分流了。
 */
function pickCandidate(
  candidates: readonly WordEntry[],
  value: string,
  mode: TypingMode,
): WordEntry {
  let progress: WordEntry | null = null;
  for (const c of candidates) {
    const r = judgeInput(c, value, mode);
    if (r.status === 'complete') return c;
    if (r.status === 'progress' && !progress) progress = c;
  }
  return progress ?? candidates[0];
}

export function useTypingInput(opts: UseTypingInputOptions) {
  const { entry, candidates, mode, now, onComplete, disabled } = opts;
  const [state, dispatch] = useReducer(typingReducer, undefined, () => initialTypingState(0));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 实际参与判定的目标集合。没传 candidates 就退化成单目标 */
  const targets = useMemo<readonly WordEntry[]>(
    () => (candidates && candidates.length > 0 ? candidates : entry ? [entry] : []),
    [candidates, entry],
  );
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  // 换词时重置。key 用所有候选的 id 拼起来 —— 多候选下任何一个换了都要重置,
  // 只看 entry?.id 会漏掉「entry 没变但备选换了」的情况。
  const targetsKey = targets.map((t) => t.id).join('|');
  useEffect(() => {
    dispatch({ type: 'RESET', now: now() });
    if (inputRef.current) inputRef.current.value = '';
  }, [targetsKey]);

  // 打完一个词:上报遥测并清空
  useEffect(() => {
    if (state.status !== 'complete' || targets.length === 0) return;
    // 命中的是哪个候选:此刻输入已经完全等于某个目标,pickCandidate 会把它选出来
    const hit = pickCandidate(targets, state.input, mode);
    onComplete({
      wordId: hit.id,
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
    if (disabled || targetsRef.current.length === 0) return;
    const value = ev.currentTarget.value;
    dispatch({ type: 'INPUT', value, entry: pickCandidate(targetsRef.current, value, mode), mode });
  }, [disabled, mode]);

  const handleCompositionStart = useCallback(() => {
    dispatch({ type: 'COMPOSITION_START' });
  }, []);

  const handleCompositionEnd = useCallback((ev: React.CompositionEvent<HTMLInputElement>) => {
    if (targetsRef.current.length === 0) return;
    const value = (ev.target as HTMLInputElement).value;
    dispatch({
      type: 'COMPOSITION_END',
      value,
      entry: pickCandidate(targetsRef.current, value, mode),
      mode,
    });
  }, [mode]);

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
