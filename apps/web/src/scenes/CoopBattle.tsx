import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AvatarState, BattleConfig, WordAttempt, WordEntry } from '@eorzea/shared/types';
import { selectPool } from '@eorzea/shared/wordbank';
import {
  createWordQueue, filterFeaturedWordPool, filterPoolByDifficulty,
  SKILLS, SKILL_COOLDOWN_MS,
  type WordQueue, type CharacterId, type Difficulty, type InputMode,
} from '@eorzea/shared/battle';
import {
  MECHANICS, currentMechanicWords,
  type MechanicId, type MechanicState,
} from '@eorzea/shared/mechanics';
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
import { MechanicPanel } from '../components/MechanicPanel';
import { SkillButton } from '../components/SkillButton';
import {
  AVATAR_PULSE_MS,
  BOSS_NAME,
  DIFFICULTY_WORD_TIMEOUT_MS,
  DIFFICULTY_SHOW_READING,
  FLASH_MS,
  PLAYER_MAX_HP,
  SHATTER_MS,
} from '../battle/constants';

export interface CoopBattleProps {
  selfId: string;
  players: PlayerPublic[];
  config: BattleConfig;
  startAt: number;
  difficulty: Difficulty;
  /** 服务端权威下发,已按难度收敛(地狱恒为 sequential) */
  inputMode: InputMode;
  bossHp: number;
  bossMaxHp: number;
  /** 两人共用一条血条,不是各自一条 */
  teamHp: number;
  scores: PlayerTick[];
  /** 进行中的机制。states 按 playerId 分开 —— 三连桶两人位置各自独立 */
  mechanicId: MechanicId | null;
  mechanicStates: Record<string, MechanicState>;
  mechanicTotalMs: number;
  mechanicEndsAt: number | null;
  mechanicClearedBy: string[];
  mechanicDone: string[];
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
    inputMode,
    bossHp,
    bossMaxHp,
    teamHp,
    scores,
    mechanicId,
    mechanicStates,
    mechanicTotalMs,
    mechanicEndsAt,
    mechanicClearedBy,
    mechanicDone,
    lastAdvancedWord,
    send,
    onExit,
  } = props;

  const showReading = DIFFICULTY_SHOW_READING[difficulty];
  const normalWordTimeoutMs = DIFFICULTY_WORD_TIMEOUT_MS[difficulty];

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

  // 技能冷却:服务端才是权威,这里只维护一份用于按钮读秒的本地副本
  const [skillReadyAt, setSkillReadyAt] = useState(0);
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
        // ★ 必须和服务端 Room.startBattle 走完全同一条流水线:
        //   selectPool → filterFeaturedWordPool → filterPoolByDifficulty。
        //   少一步或顺序不同,两边词池就不同,词序从第一个词起全错位。
        //   打断词不用管,服务端会在 boss_cast 里直接把词发过来。
        const p = filterPoolByDifficulty(
          filterFeaturedWordPool(selectPool(banks, { categories: config.categories, pureOnly: config.pureOnly })),
          difficulty,
        );
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

  // 机制结算的视觉反馈。
  //
  // ★ 这里绝对不能消费词队列。机制是插进来的一次挑战,普通词在机制期间原地
  //   冻结(服务端 resumeNormalWord 同样不推进),打完回到同一个词。以前这里多
  //   next() 过一次,两边游标就永久错开一格,之后所有 word_attempt 都会被服务端
  //   按 wordId 不匹配丢弃 —— 玩家再也打不出伤害,只能被超时一路扣血到团灭。
  const seenResolveKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (mechanicId !== null || mechanicClearedBy.length === 0) return;
    const key = mechanicClearedBy.join(',');
    if (seenResolveKeyRef.current === key) return;
    seenResolveKeyRef.current = key;

    setShattered(true);
    window.setTimeout(() => setShattered(false), SHATTER_MS);
    audio.play('interrupt');
    if (mechanicClearedBy.includes(selfId)) {
      setAvatarState('attack');
      window.setTimeout(() => setAvatarState('idle'), AVATAR_PULSE_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mechanicId, mechanicClearedBy]);

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

  // 机制进行中打的是**自己那一份**机制状态给出的词(三连桶两人方向词不同,
  // 抄对方的操作没用);否则打普通词。
  const opponentForMech = players.find((p) => p.playerId !== selfId);
  const opponentMechanic = mechanicId && opponentForMech
    ? mechanicStates[opponentForMech.playerId] ?? null
    : null;
  const selfCharacter: CharacterId = players.find((p) => p.playerId === selfId)?.character ?? 'p1';
  const selfMechanic = mechanicId ? mechanicStates[selfId] ?? null : null;
  const mechanicWords = selfMechanic ? currentMechanicWords(selfMechanic) : [];
  const inMechanic = !!selfMechanic;
  const entry = mechanicWords[0] ?? localWord;

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
    if (inMechanic) {
      // ★ 机制里一次要打好几个词(三连桶要走好几格、三穿一要打三个),打完一个
      //   必须把输入状态清干净。不清的话 reducer 一直停在 'complete',下一个词
      //   若被 React 批处理掉中间的 'progress',`[state.status]` 依赖就不变化,
      //   完成回调再也不触发 —— 表现是机制走到第二步就彻底卡死,而且毫无报错。
      //   判定与推进由服务端裁定,这里只清输入、等 mechanic_* 广播回来。
      resetTyping();
      return;
    }
    if (!inMechanic) {
      setAvatarState('attack');
      window.setTimeout(() => setAvatarState('idle'), AVATAR_PULSE_MS);
      audio.play('hit_slash');
      if (queueRef.current) setLocalWord(queueRef.current.next());
    }
    // 机制中的判定与推进全部由服务端裁定(见 Room.handleMechanicAttempt),
    // 客户端只管把 attempt 发过去,视觉反馈等 mechanic_* 广播回来再做。
  }

  const { state: typingState, inputRef, inputProps, reset: resetTyping } = useTypingInput({
    entry,
    candidates: mechanicWords.length > 0 ? mechanicWords : undefined,
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
  //
  // ★ 组合输入完全不进这个分支:错了只把输入框染红,既不上报失败也不清空,
  //   玩家自己退格改到绿为止。
  const autoFailedStateRef = useRef<typeof typingState | null>(null);
  useEffect(() => {
    if (inputMode === 'composed') return;
    if (typingState.status === 'error' && autoFailedStateRef.current !== typingState) {
      autoFailedStateRef.current = typingState;
      if (difficulty === 'hell') handleFailedInput();
      else resetTyping();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingState.status, inputMode]);

  function onKeyDown(ev: KeyboardEvent<HTMLInputElement>) {
    inputProps.onKeyDown(ev);

    // Tab 开技能,理由与按键选择见 SoloBattle 里同一处的注释
    if (ev.key === 'Tab' && !ev.nativeEvent.isComposing) {
      ev.preventDefault();
      if (!inMechanic && now() >= skillReadyAt) {
        send({ t: 'use_skill' });
        setSkillReadyAt(now() + SKILL_COOLDOWN_MS);
      }
      return;
    }

    // 组合输入下 Enter 不清空,理由同 SoloBattle
    if (inputMode === 'composed') return;
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
        maxHp={bossMaxHp || config.bossHp}
        cast={
          selfMechanic
            ? {
                skillName: MECHANICS[selfMechanic.id].name,
                word: mechanicWords[0] ?? null,
                startedAt: (mechanicEndsAt ?? 0) - mechanicTotalMs,
                castMs: mechanicTotalMs,
              }
            : null
        }
        shattered={shattered}
      />
      <PartyList players={partyPlayers} />

      <div className="battle__mid">
        <div className="battle__player-status">
          <HpBar value={teamHp} max={PLAYER_MAX_HP} variant="player" />
          <CountdownBar label="狂暴倒计时" remainingMs={remainingMs} totalMs={config.durationMs} variant="enrage" />
          {!inMechanic && (
            <CountdownBar
              label="普通词倒计时"
              remainingMs={normalWordRemainingMs}
              totalMs={normalWordTimeoutMs}
              variant="word"
            />
          )}
        </div>
      </div>

      {selfMechanic && (
        <MechanicPanel
          state={selfMechanic}
          remainingMs={Math.max(0, (mechanicEndsAt ?? 0) - Date.now())}
          totalMs={mechanicTotalMs}
        />
      )}
      {/* 队友那一份:三连桶两人位置独立,得能看见队友躲到哪了 */}
      {opponentMechanic && opponent && (
        <div className="mechanic-teammate">
          <div className="mechanic-teammate__title">
            队友 {opponent.nick}
            {mechanicDone.includes(opponent.playerId) ? ' · 已躲开 ✓' : ' · 进行中'}
          </div>
          <MechanicPanel state={opponentMechanic} remainingMs={0} totalMs={0} compact />
        </div>
      )}

      <TypingField
        entry={entry}
        status={typingState.status}
        matchedLength={typingState.matchedLength}
        mode={config.mode}
        inputProps={{ ...inputProps, ref: inputRef, onKeyDown }}
        isInterrupt={inMechanic}
        alternatives={mechanicWords.length > 1 ? mechanicWords : undefined}
        showReading={showReading}
        inputMode={inputMode}
      />
      <div className="battle__actions">
        <SkillButton
          skill={SKILLS[selfCharacter]}
          readyAt={skillReadyAt}
          now={now}
          disabled={inMechanic}
          onUse={() => {
            send({ t: 'use_skill' });
            // 冷却本地先转起来,服务端也在算同一份;它才是权威,这里只是即时反馈
            setSkillReadyAt(now() + SKILL_COOLDOWN_MS);
          }}
        />
      <button className="battle__skip" type="button" onClick={surrenderCurrentWord}>
        {selfMechanic ? `放弃${MECHANICS[selfMechanic.id].name}` : '放弃当前词'}
      </button>
      </div>
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
      <p className="battle__hint">
        {inputMode === 'composed'
          ? '组合输入:打错不会立刻判负,输入框变红时退格改到变绿即可;普通词超时仍会扣团队血。'
          : '逐字输入:打错立刻结算(地狱直接判负,其余清空重来);普通词超时会扣团队血。'}
      </p>
    </div>
  );
}
