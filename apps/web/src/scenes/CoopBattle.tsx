import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AvatarState, BattleConfig, WordAttempt, WordEntry } from '@eorzea/shared/types';
import { selectPool } from '@eorzea/shared/wordbank';
import { createWordQueue, filterFeaturedWordPool, type WordQueue, type Difficulty } from '@eorzea/shared/battle';
import { useTypingInput } from '../engine/useTypingInput';
import { audio } from '../engine/audio';
import { loadBanks } from '../data/wordbankLoader';
import type { C2S, PlayerPublic, PlayerTick } from '../engine/coopProtocol';
import { BossPanel } from '../components/BossPanel';
import { TypingField } from '../components/TypingField';
import { Avatar, type CombatText } from '../components/Avatar';
import { HpBar } from '../components/HpBar';
import { PartyList } from '../components/PartyList';
import { CountdownBar } from '../components/CountdownBar';
import { BattleExitControl } from '../components/BattleExitControl';
import {
  AVATAR_PULSE_MS,
  BOSS_NAME,
  CAST_DURATION_MS,
  DIFFICULTY_CAST_MULTIPLIER,
  DIFFICULTY_SHOW_READING,
  FLASH_MS,
  NORMAL_WORD_TIMEOUT_MULTIPLIER,
  PLAYER_MAX_HP,
  SHATTER_MS,
} from '../battle/constants';

export interface CoopCastInfo {
  castId: string;
  skillName: string;
  word: WordEntry;
  castMs: number;
  startedAt: number;
}

export interface CoopBattleProps {
  selfId: string;
  players: PlayerPublic[];
  config: BattleConfig;
  startAt: number;
  difficulty: Difficulty;
  bossHp: number;
  /** 两人共用一条血条,不是各自一条 */
  teamHp: number;
  scores: PlayerTick[];
  castWarning: boolean;
  cast: CoopCastInfo | null;
  lastResolvedCastId: string | null;
  lastInterruptedBy: string | null;
  lastAdvancedWord: { playerId: string; wordId: string } | null;
  send: (msg: C2S) => void;
  onExit: () => void;
}

/**
 * 服务端权威:这里的「打对/打错」全部是乐观预测(用同一份 judgeInput 本地判定,
 * 立刻推进到本地下一个词),真正花钱的伤害/血量以服务端 score_tick 广播为准。
 * 词序列由 config.seed + config.categories 本地生成,和服务端各自独立消费同一序列。
 *
 * 连击数直接读服务端广播的 PlayerTick.combo,不再本地维护一份——两份连击数
 * 容易在打断/超时这些服务端专属分支上跑偏,权威数据摆在眼前没理由不用。
 */
export function CoopBattle(props: CoopBattleProps) {
  const {
    selfId,
    players,
    config,
    startAt,
    difficulty,
    bossHp,
    teamHp,
    scores,
    castWarning,
    cast,
    lastResolvedCastId,
    lastInterruptedBy,
    lastAdvancedWord,
    send,
    onExit,
  } = props;

  const showReading = DIFFICULTY_SHOW_READING[difficulty];
  const normalWordTimeoutMs = Math.round(
    CAST_DURATION_MS * DIFFICULTY_CAST_MULTIPLIER[difficulty] * NORMAL_WORD_TIMEOUT_MULTIPLIER,
  );

  const [pool, setPool] = useState<WordEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const queueRef = useRef<WordQueue | null>(null);
  const [localWord, setLocalWord] = useState<WordEntry | null>(null);
  const [avatarState, setAvatarState] = useState<AvatarState>('idle');
  const [opponentState, setOpponentState] = useState<AvatarState>('idle');
  const [selfCombatTexts, setSelfCombatTexts] = useState<CombatText[]>([]);
  const [opponentCombatTexts, setOpponentCombatTexts] = useState<CombatText[]>([]);
  const [shattered, setShattered] = useState(false);
  const [flash, setFlash] = useState(false);
  const [remainingMs, setRemainingMs] = useState(Math.max(0, config.durationMs - (Date.now() - startAt)));

  const prevScoresRef = useRef<Map<string, PlayerTick>>(new Map());
  const prevTeamHpRef = useRef(teamHp);
  const seenResolveRef = useRef<string | null>(null);
  const seenAdvanceRef = useRef<string | null>(null);
  const combatTextIdRef = useRef(0);
  const combatTextTimersRef = useRef<number[]>([]);

  function showCombatText(target: 'self' | 'opponent', kind: CombatText['kind'], amount: number) {
    if (amount <= 0) return;
    const id = ++combatTextIdRef.current;
    const setTexts = target === 'self' ? setSelfCombatTexts : setOpponentCombatTexts;
    setTexts((texts) => [...texts.slice(-2), { id, kind, amount }]);
    const timer = window.setTimeout(() => {
      setTexts((texts) => texts.filter((text) => text.id !== id));
    }, 1_050);
    combatTextTimersRef.current.push(timer);
  }

  useEffect(() => () => {
    combatTextTimersRef.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    let alive = true;
    loadBanks(config.categories)
      .then((banks) => {
        if (!alive) return;
        const p = filterFeaturedWordPool(selectPool(banks, { categories: config.categories, pureOnly: config.pureOnly }));
        if (p.length === 0) throw new Error('词池为空');
        setPool(p);
        queueRef.current = createWordQueue(p, config.seed);
        setLocalWord(queueRef.current.next());
      })
      .catch((e) => setLoadError(String(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemainingMs(Math.max(0, config.durationMs - (Date.now() - startAt)));
    }, 250);
    return () => window.clearInterval(id);
  }, [config.durationMs, startAt]);

  // 读条结算:只处理打断成功的反馈(碎裂+音效+自己命中的话再弹一下)。
  // 团灭/扣血的反馈统一交给下面 teamHp 的 diff 效果,不管扣血是谁造成的。
  useEffect(() => {
    if (!lastResolvedCastId || seenResolveRef.current === lastResolvedCastId) return;
    seenResolveRef.current = lastResolvedCastId;

    if (lastInterruptedBy) {
      setShattered(true);
      window.setTimeout(() => setShattered(false), SHATTER_MS);
      audio.play('interrupt');
      if (lastInterruptedBy === selfId) {
        setAvatarState('attack');
        window.setTimeout(() => setAvatarState('idle'), AVATAR_PULSE_MS);
      }
    }
    if (queueRef.current) setLocalWord(queueRef.current.next());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastResolvedCastId, lastInterruptedBy]);

  // 普通词超时或地狱模式输错由服务端结算。只有对应玩家消费本地队列，避免超时后
  // 前后端各自停在不同词上；正确完成仍维持原有的乐观推进。
  useEffect(() => {
    if (!lastAdvancedWord || lastAdvancedWord.playerId !== selfId || !localWord || !queueRef.current) return;
    const key = `${lastAdvancedWord.playerId}:${lastAdvancedWord.wordId}`;
    if (seenAdvanceRef.current === key || localWord.id !== lastAdvancedWord.wordId) return;
    seenAdvanceRef.current = key;
    setLocalWord(queueRef.current.next());
  }, [lastAdvancedWord, selfId, localWord]);

  // 团队血条只要掉了,不管是谁造成的,都闪一下红屏 + 受伤音效
  useEffect(() => {
    if (teamHp < prevTeamHpRef.current) {
      const lostHp = prevTeamHpRef.current - teamHp;
      setFlash(true);
      window.setTimeout(() => setFlash(false), FLASH_MS);
      audio.play('hurt');
      showCombatText('self', 'hurt', lostHp);
      if (players.some((player) => player.playerId !== selfId)) showCombatText('opponent', 'hurt', lostHp);
    }
    prevTeamHpRef.current = teamHp;
  }, [teamHp, players, selfId]);

  const now = () => Date.now() - startAt;

  // 小人动作和输出伤害数字都由 score_tick 的权威 diff 驱动。
  useEffect(() => {
    const self = players.find((p) => p.playerId === selfId);
    if (self) {
      const prev = prevScoresRef.current.get(self.playerId);
      const cur = scores.find((s) => s.playerId === self.playerId);
      if (cur && prev && cur.damage > prev.damage) showCombatText('self', 'damage', cur.damage - prev.damage);
    }
    const opponent = players.find((p) => p.playerId !== selfId);
    if (opponent) {
      const prev = prevScoresRef.current.get(opponent.playerId);
      const cur = scores.find((s) => s.playerId === opponent.playerId);
      if (cur && prev) {
        if (cur.damage > prev.damage) showCombatText('opponent', 'damage', cur.damage - prev.damage);
        if (cur.wordsCompleted > prev.wordsCompleted) {
          setOpponentState('attack');
          window.setTimeout(() => setOpponentState('idle'), AVATAR_PULSE_MS);
        } else if (cur.misses > prev.misses) {
          setOpponentState('miss');
          window.setTimeout(() => setOpponentState('idle'), AVATAR_PULSE_MS);
        }
      }
    }
    const next = new Map(prevScoresRef.current);
    for (const s of scores) next.set(s.playerId, s);
    prevScoresRef.current = next;
  }, [scores, players, selfId]);

  const isInterrupt = !!cast;
  const entry = isInterrupt ? cast!.word : localWord;

  function handleComplete(payload: {
    submitted: string;
    keystrokes: WordAttempt['keystrokes'];
    backspaces: number;
    compositionCommits: number;
    focusLostMs: number;
    startedAt: number;
    submittedAt: number;
  }) {
    if (!entry) return;
    send({ t: 'word_attempt', attempt: { wordId: entry.id, ...payload } });
    if (!isInterrupt) {
      setAvatarState('attack');
      window.setTimeout(() => setAvatarState('idle'), AVATAR_PULSE_MS);
      audio.play('hit_slash');
      if (queueRef.current) setLocalWord(queueRef.current.next());
    }
    // isInterrupt 的情况下,「谁先抢到」由服务端裁定,视觉反馈交给
    // lastResolvedCastId 的 effect 统一处理,这里不重复播放。
  }

  const { state: typingState, inputRef, inputProps, reset: resetTyping } = useTypingInput({
    entry,
    mode: config.mode,
    now,
    onComplete: handleComplete,
    disabled: !entry,
  });
  const normalWordRemainingMs = Math.max(0, normalWordTimeoutMs - (now() - typingState.wordStartedAt));

  function handleFailedInput() {
    if (!entry) return;
    if (difficulty !== 'hell') {
      resetTyping();
      return;
    }
    send({
      t: 'word_attempt',
      attempt: {
        wordId: entry.id,
        startedAt: typingState.wordStartedAt,
        submittedAt: now(),
        submitted: typingState.input,
        keystrokes: typingState.keystrokes,
        backspaces: typingState.backspaces,
        compositionCommits: typingState.compositionCommits,
        focusLostMs: typingState.focusLostMs,
      },
    });
    setAvatarState('miss');
    window.setTimeout(() => setAvatarState('idle'), AVATAR_PULSE_MS);
    audio.play('miss');
  }

  function surrenderCurrentWord() {
    if (!entry) return;
    send({ t: 'skip_word', wordId: entry.id });
    setAvatarState('miss');
    window.setTimeout(() => setAvatarState('idle'), AVATAR_PULSE_MS);
    audio.play('miss');
  }

  useEffect(() => {
    inputRef.current?.focus();
  }, [entry?.id]);

  // 一个字打错就立刻上报失败,不等玩家退格重试或按 Enter。用 typingState 的
  // 对象引用去重,原因同 SoloBattle.tsx 里的一样:StrictMode 开发环境下
  // 会把没清理函数的非幂等 effect 多跑一次,不去重会导致一次失误顶两次算。
  const autoFailedStateRef = useRef<typeof typingState | null>(null);
  useEffect(() => {
    if (typingState.status === 'error' && autoFailedStateRef.current !== typingState) {
      autoFailedStateRef.current = typingState;
      if (difficulty === 'hell') handleFailedInput();
      else resetTyping();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingState.status]);

  function onKeyDown(ev: KeyboardEvent<HTMLInputElement>) {
    inputProps.onKeyDown(ev);
    if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
      if (difficulty === 'hell') handleFailedInput();
      else resetTyping();
    }
  }

  const self = players.find((p) => p.playerId === selfId);
  const opponent = players.find((p) => p.playerId !== selfId);
  const myCombo = scores.find((s) => s.playerId === selfId)?.combo ?? 0;
  const opponentCombo = opponent ? (scores.find((s) => s.playerId === opponent.playerId)?.combo ?? 0) : 0;
  const partyPlayers = players.map((p) => ({
    playerId: p.playerId,
    nick: p.nick,
    score: scores.find((s) => s.playerId === p.playerId)?.score ?? 0,
    isSelf: p.playerId === selfId,
  }));

  if (loadError) {
    return <div className="menu__error">词库加载失败:{loadError}</div>;
  }
  if (!pool || !entry) {
    return <div className="menu">词库加载中…</div>;
  }

  return (
    <div className={`battle${flash ? ' battle--flash' : ''}`}>
      <BossPanel
        name={BOSS_NAME}
        hp={bossHp}
        maxHp={config.bossHp}
        cast={
          isInterrupt
            ? { skillName: cast!.skillName, word: cast!.word, startedAt: cast!.startedAt, castMs: cast!.castMs }
            : null
        }
        shattered={shattered}
      />
      {castWarning && <div className="battle__cast-warning">⚠ 泰坦即将咆哮!</div>}
      <PartyList players={partyPlayers} />

      <div className="battle__mid">
        <div className="battle__player-status">
          <HpBar value={teamHp} max={PLAYER_MAX_HP} variant="player" />
          <CountdownBar label="狂暴倒计时" remainingMs={remainingMs} totalMs={config.durationMs} variant="enrage" />
          {!isInterrupt && (
            <CountdownBar
              label="普通词倒计时"
              remainingMs={normalWordRemainingMs}
              totalMs={normalWordTimeoutMs}
              variant="word"
            />
          )}
        </div>
      </div>

      <TypingField
        entry={entry}
        status={typingState.status}
        matchedLength={typingState.matchedLength}
        mode={config.mode}
        inputProps={{ ...inputProps, ref: inputRef, onKeyDown }}
        isInterrupt={isInterrupt}
        showReading={showReading}
      />
      <button className="battle__skip" type="button" onClick={surrenderCurrentWord}>
        {isInterrupt ? '放弃本次打断' : '放弃当前词'}
      </button>
      <BattleExitControl isCoop onConfirm={onExit} />

      <div className="battle__avatar-row">
        <div className="battle__side">
          <div className="battle__side-combo">连击 x{myCombo}</div>
          <Avatar state={avatarState} nick={self?.nick ?? '你'} isSelf slot="p1" combatTexts={selfCombatTexts} />
        </div>
        {opponent && (
          <div className="battle__side">
            <div className="battle__side-combo">连击 x{opponentCombo}</div>
            <Avatar state={opponentState} nick={opponent.nick} isSelf={false} slot="p2" combatTexts={opponentCombatTexts} />
          </div>
        )}
      </div>
      <p className="battle__hint">普通词超时会扣团队血并可能触发泰坦之怒;地狱模式打错一个字也会直接失败。</p>
    </div>
  );
}
