import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AvatarState, TypingMode, WordAttempt, WordEntry } from '@eorzea/shared/types';
import { computeDamage, computeScore, computeStats, targetOf, type SessionStats } from '@eorzea/shared/scoring';
import { createWordQueue, pickShortInterruptWord } from '@eorzea/shared/battle';
import { useTypingInput } from '../engine/useTypingInput';
import { audio } from '../engine/audio';
import {
  AVATAR_PULSE_MS,
  BATTLE_DURATION_MS,
  BOSS_MAX_HP,
  BOSS_NAME,
  BOSS_SKILL_NAME,
  CAST_DURATION_MS,
  DIFFICULTY_CAST_MULTIPLIER,
  DIFFICULTY_SHOW_READING,
  FLASH_MS,
  NORMAL_WORD_TIMEOUT_MULTIPLIER,
  PLAYER_DAMAGE_ON_FAIL,
  PLAYER_DAMAGE_ON_MISS,
  PLAYER_HEAL_ON_INTERRUPT,
  PLAYER_MAX_HP,
  SHATTER_MS,
  TITAN_WRATH_ON_FAILURE_CHANCE,
  TITAN_WRATH_ON_SUCCESS_CHANCE,
  type Difficulty,
} from '../battle/constants';
import { BossPanel } from '../components/BossPanel';
import { TypingField } from '../components/TypingField';
import { Avatar, type CombatText } from '../components/Avatar';
import { HpBar } from '../components/HpBar';
import { CountdownBar } from '../components/CountdownBar';
import { BattleExitControl } from '../components/BattleExitControl';

export interface SoloResult {
  victory: boolean;
  /** 非胜利时区分到底是血量归零秒结,还是单纯打到时间到 */
  reason: 'boss_defeated' | 'player_defeated' | 'time_up';
  score: number;
  damage: number;
  interruptsSucceeded: number;
  interruptsFailed: number;
  stats: SessionStats;
}

export interface SoloBattleProps {
  pool: WordEntry[];
  mode: TypingMode;
  difficulty: Difficulty;
  onFinish: (result: SoloResult) => void;
  onExit: () => void;
}

interface CastInfo {
  skillName: string;
  word: WordEntry;
  startedAt: number;
  castMs: number;
}

interface EngineState {
  bossHp: number;
  playerHp: number;
  combo: number;
  currentWord: WordEntry | null;
  isInterrupt: boolean;
  castInfo: CastInfo | null;
  remainingMs: number;
  ended: boolean;
  avatarState: AvatarState;
  shattered: boolean;
  flash: boolean;
  interruptsSucceeded: number;
  interruptsFailed: number;
  totalDamage: number;
  combatTexts: CombatText[];
}

function initEngine(): EngineState {
  return {
    bossHp: BOSS_MAX_HP,
    playerHp: PLAYER_MAX_HP,
    combo: 0,
    currentWord: null,
    isInterrupt: false,
    castInfo: null,
    remainingMs: BATTLE_DURATION_MS,
    ended: false,
    avatarState: 'idle',
    shattered: false,
    flash: false,
    interruptsSucceeded: 0,
    interruptsFailed: 0,
    totalDamage: 0,
    combatTexts: [],
  };
}

/**
 * 战斗引擎状态放在 ref 里而不是 useState —— 计时器(读条、tick)与事件处理器
 * 全部通过这个 ref 读写最新状态,不会有 setState 闭包过期的问题。
 * rerender() 只是告诉 React "该重画了",不是数据来源。
 *
 * ★ 血量归零直接秒结(defeat),没有"倒地复活"这一套——那是联机才有的,
 *   单机死了就是死了。
 */
export function SoloBattle({ pool, mode, difficulty, onFinish, onExit }: SoloBattleProps) {
  const engineRef = useRef<EngineState>(initEngine());
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((n) => n + 1);

  const castDurationMs = Math.round(CAST_DURATION_MS * DIFFICULTY_CAST_MULTIPLIER[difficulty]);
  const wordTimeoutMs = Math.round(castDurationMs * NORMAL_WORD_TIMEOUT_MULTIPLIER);
  const showReading = DIFFICULTY_SHOW_READING[difficulty];

  const battleStartRef = useRef(performance.now());
  const now = () => performance.now() - battleStartRef.current;

  const seedRef = useRef(`solo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const queueRef = useRef(createWordQueue(pool, seedRef.current));
  const attemptsRef = useRef<WordAttempt[]>([]);
  const targetsRef = useRef(new Map<string, string>());
  const finishedRef = useRef(false);
  const castDeadlineRef = useRef<number | null>(null);
  const wordDeadlineRef = useRef<number | null>(null);
  const tickTimerRef = useRef<number | null>(null);
  const revertTimersRef = useRef<number[]>([]);
  const combatTextIdRef = useRef(0);

  function scheduleRevert(patch: Partial<EngineState>, delay: number) {
    const t = window.setTimeout(() => {
      Object.assign(engineRef.current, patch);
      rerender();
    }, delay);
    revertTimersRef.current.push(t);
  }

  function finish(victory: boolean, reason: SoloResult['reason']) {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const e = engineRef.current;
    if (tickTimerRef.current) window.clearInterval(tickTimerRef.current);
    revertTimersRef.current.forEach((t) => window.clearTimeout(t));
    audio.stopBgm();
    const stats = computeStats(attemptsRef.current, now(), mode, targetsRef.current);
    const score = computeScore(e.totalDamage, e.interruptsSucceeded, stats.accuracy);
    onFinish({
      victory,
      reason,
      score,
      damage: e.totalDamage,
      interruptsSucceeded: e.interruptsSucceeded,
      interruptsFailed: e.interruptsFailed,
      stats,
    });
  }

  /** 血量归零直接秒结,单机没有复活机制 */
  function checkDeath(): boolean {
    const e = engineRef.current;
    if (e.playerHp > 0) return false;
    e.ended = true;
    rerender();
    finish(false, 'player_defeated');
    return true;
  }

  function drawNext() {
    const e = engineRef.current;
    if (e.ended) return;
    e.currentWord = queueRef.current.next();
    e.isInterrupt = false;
    e.castInfo = null;
    wordDeadlineRef.current = now() + wordTimeoutMs;
  }

  function showCombatText(kind: CombatText['kind'], amount: number) {
    if (amount <= 0) return;
    const e = engineRef.current;
    const id = ++combatTextIdRef.current;
    e.combatTexts = [...e.combatTexts.slice(-2), { id, kind, amount }];
    const t = window.setTimeout(() => {
      engineRef.current.combatTexts = engineRef.current.combatTexts.filter((text) => text.id !== id);
      rerender();
    }, 1_050);
    revertTimersRef.current.push(t);
  }

  function applyDamage(word: WordEntry, isInterrupt: boolean) {
    const e = engineRef.current;
    const dmg = computeDamage(word.difficulty, e.combo, isInterrupt);
    e.bossHp = Math.max(0, e.bossHp - dmg);
    e.combo += 1;
    e.totalDamage += dmg;
    showCombatText('damage', dmg);
    e.avatarState = 'attack';
    scheduleRevert({ avatarState: 'idle' }, AVATAR_PULSE_MS);
    return dmg;
  }

  function resolveInterruptFail() {
    const e = engineRef.current;
    e.isInterrupt = false;
    e.castInfo = null;
    e.interruptsFailed += 1;
    const lostHp = Math.min(e.playerHp, PLAYER_DAMAGE_ON_FAIL);
    e.playerHp -= lostHp;
    showCombatText('hurt', lostHp);
    e.flash = true;
    scheduleRevert({ flash: false }, FLASH_MS);
    audio.play('hurt');
    if (checkDeath()) return;
    drawNext();
    rerender();
  }

  function resolveNormalMiss() {
    const e = engineRef.current;
    e.combo = 0;
    e.avatarState = 'miss';
    scheduleRevert({ avatarState: 'idle' }, AVATAR_PULSE_MS);
    audio.play('miss');
    const lostHp = Math.min(e.playerHp, PLAYER_DAMAGE_ON_MISS);
    e.playerHp -= lostHp;
    showCombatText('hurt', lostHp);
    e.flash = true;
    scheduleRevert({ flash: false }, FLASH_MS);
    if (checkDeath()) return;
    if (!tryTriggerTitanWrath(TITAN_WRATH_ON_FAILURE_CHANCE)) drawNext();
    rerender();
  }

  /** 泰坦之怒只由一次普通词失败随机触发,绝不再用定时器抢断正在输入的词。 */
  function tryTriggerTitanWrath(chance: number): boolean {
    if (Math.random() >= chance) return false;
    beginInterrupt();
    return engineRef.current.isInterrupt;
  }

  /** 打错/跳过/超时,统一入口——是打断期就走躲避失败,否则走普通词失败 */
  function resolveMiss() {
    const e = engineRef.current;
    if (e.isInterrupt) {
      e.combo = 0;
      resolveInterruptFail();
    } else {
      resolveNormalMiss();
    }
  }

  function handleComplete(payload: {
    submitted: string;
    keystrokes: WordAttempt['keystrokes'];
    backspaces: number;
    compositionCommits: number;
    focusLostMs: number;
    startedAt: number;
    submittedAt: number;
  }) {
    const e = engineRef.current;
    if (e.ended || !e.currentWord) return;
    const word = e.currentWord;
    attemptsRef.current.push({ wordId: word.id, ...payload });
    targetsRef.current.set(word.id, targetOf(word, mode));

    if (e.isInterrupt) {
      applyDamage(word, true);
      e.interruptsSucceeded += 1;
      e.isInterrupt = false;
      e.castInfo = null;
      e.shattered = true;
      scheduleRevert({ shattered: false }, SHATTER_MS);
      audio.play('interrupt');
      e.playerHp = Math.min(PLAYER_MAX_HP, e.playerHp + PLAYER_HEAL_ON_INTERRUPT);
    } else {
      applyDamage(word, false);
      audio.play('hit_slash');
    }

    if (e.bossHp <= 0) {
      e.ended = true;
      audio.play('victory');
      rerender();
      finish(true, 'boss_defeated');
      return;
    }
    if (!tryTriggerTitanWrath(TITAN_WRATH_ON_SUCCESS_CHANCE)) drawNext();
    rerender();
  }

  function handleSkip() {
    const e = engineRef.current;
    if (e.ended || !e.currentWord) return;
    const word = e.currentWord;
    attemptsRef.current.push({
      wordId: word.id,
      startedAt: typingState.wordStartedAt,
      submittedAt: now(),
      submitted: typingState.input,
      keystrokes: typingState.keystrokes,
      backspaces: typingState.backspaces,
      compositionCommits: typingState.compositionCommits,
      focusLostMs: typingState.focusLostMs,
    });
    targetsRef.current.set(word.id, targetOf(word, mode));
    resolveMiss();
  }

  function beginInterrupt() {
    const e = engineRef.current;
    if (e.ended) return;
    const word = pickShortInterruptWord(pool, `${seedRef.current}:cast:${Math.floor(now())}`);
    if (!word) {
      rerender();
      return;
    }
    e.isInterrupt = true;
    e.currentWord = word;
    e.castInfo = { skillName: BOSS_SKILL_NAME, word, startedAt: now(), castMs: castDurationMs };
    castDeadlineRef.current = now() + castDurationMs;
    rerender();
  }

  function tick() {
    const e = engineRef.current;
    if (e.ended) return;
    const elapsed = now();
    e.remainingMs = Math.max(0, BATTLE_DURATION_MS - elapsed);

    if (e.isInterrupt && castDeadlineRef.current !== null && elapsed >= castDeadlineRef.current) {
      castDeadlineRef.current = null;
      resolveInterruptFail();
      return;
    }
    if (!e.isInterrupt && wordDeadlineRef.current !== null && elapsed >= wordDeadlineRef.current) {
      wordDeadlineRef.current = null;
      resolveNormalMiss();
      return;
    }
    if (e.remainingMs <= 0) {
      e.ended = true;
      rerender();
      finish(false, 'time_up');
      return;
    }
    rerender();
  }

  useEffect(() => {
    drawNext();
    tickTimerRef.current = window.setInterval(tick, 100);
    audio.loadBgm().then(() => {
      if (!finishedRef.current) audio.startBgm();
    });
    rerender();
    return () => {
      if (tickTimerRef.current) window.clearInterval(tickTimerRef.current);
      revertTimersRef.current.forEach((t) => window.clearTimeout(t));
      audio.stopBgm();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const e = engineRef.current;

  const { state: typingState, inputRef, inputProps, reset: resetTyping } = useTypingInput({
    entry: e.currentWord,
    mode,
    now,
    onComplete: handleComplete,
    disabled: e.ended,
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, [e.currentWord?.id]);

  // 一个字打错就立刻算失败,不等玩家退格重试或按 Enter。
  // 用 typingState 的对象引用去重——React 18 StrictMode 在开发环境下会把
  // 依赖没变的 effect 再多跑一次(mount -> cleanup -> mount)来揪有没有
  // 忘写清理函数的 bug,这个 effect 本身没有清理函数、又是非幂等的副作用
  // (会扣血、切词),不去重的话开发环境下一次失误会顶两次算。
  const autoFailedStateRef = useRef<typeof typingState | null>(null);
  useEffect(() => {
    if (typingState.status === 'error' && autoFailedStateRef.current !== typingState) {
      autoFailedStateRef.current = typingState;
      if (difficulty === 'hell') handleSkip();
      else resetTyping();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingState.status]);

  function onKeyDown(ev: KeyboardEvent<HTMLInputElement>) {
    inputProps.onKeyDown(ev);
    if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
      if (difficulty === 'hell') handleSkip();
      else resetTyping();
    }
  }

  return (
    <div className={`battle${e.flash ? ' battle--flash' : ''}`}>
      <BossPanel name={BOSS_NAME} hp={e.bossHp} maxHp={BOSS_MAX_HP} cast={e.castInfo} shattered={e.shattered} />

      <div className="battle__mid">
        <div className="battle__player-status">
          <HpBar value={e.playerHp} max={PLAYER_MAX_HP} variant="player" />
          <CountdownBar label="狂暴倒计时" remainingMs={e.remainingMs} totalMs={BATTLE_DURATION_MS} variant="enrage" />
          {!e.isInterrupt && wordDeadlineRef.current !== null && (
            <CountdownBar
              label="普通词倒计时"
              remainingMs={Math.max(0, wordDeadlineRef.current - now())}
              totalMs={wordTimeoutMs}
              variant="word"
            />
          )}
        </div>
      </div>

      <TypingField
        entry={e.currentWord}
        status={typingState.status}
        matchedLength={typingState.matchedLength}
        mode={mode}
        inputProps={{ ...inputProps, ref: inputRef, onKeyDown }}
        isInterrupt={e.isInterrupt}
        showReading={showReading}
      />
      <button className="battle__skip" type="button" disabled={e.ended} onClick={handleSkip}>
        {e.isInterrupt ? '放弃本次打断' : '放弃当前词'}
      </button>
      <BattleExitControl onConfirm={onExit} />

      <div className="battle__avatar-row">
        <div className="battle__side">
          <div className="battle__side-combo">连击 x{e.combo}</div>
          <Avatar state={e.avatarState} nick="你" isSelf slot="p1" combatTexts={e.combatTexts} />
        </div>
      </div>
      <p className="battle__hint">普通词超时会扣血并可能触发泰坦之怒;地狱模式打错一个字也会直接失败。</p>
    </div>
  );
}
