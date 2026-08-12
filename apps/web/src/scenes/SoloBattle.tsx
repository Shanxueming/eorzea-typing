import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AvatarState, TypingMode, WordAttempt, WordCategory, WordEntry } from '@eorzea/shared/types';
import { computeDamage, computeScore, computeStats, targetOf, type SessionStats } from '@eorzea/shared/scoring';
import { analyzeSession, checkAttempt } from '@eorzea/shared/anticheat';
import { bossHpFor, createWordQueue, expandPinyinCandidates, filterPoolByDifficulty } from '@eorzea/shared/battle';
import {
  challengeMechanicRoll,
  challengeMechanicSeed,
  mechanicAt,
  type ChallengeScript,
} from '@eorzea/shared/challenge';
import {
  ENDLESS_MECHANIC_CHANCE,
  ENDLESS_MECHANIC_THRESHOLDS,
  MECHANICS,
  createMechanicState,
  crossedThresholds,
  currentMechanicWords,
  mechanicDurationMs,
  mechanicForHpDrop,
  submitMechanicWord,
  type MechanicId,
  type MechanicState,
} from '@eorzea/shared/mechanics';
import { useTypingInput } from '../engine/useTypingInput';
import { audio } from '../engine/audio';
import {
  AVATAR_PULSE_MS,
  BATTLE_DURATION_MS,
  BLOODBATH_MULTIPLIER,
  BLOODBATH_TIME_SCALE,
  BLOODBATH_WORDS,
  BOSS_MAX_HP,
  BOSS_NAME,
  BOSS_SKILL_NAME,
  ENDLESS_BOSS_HP_GROWTH,
  ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS,
  ENDLESS_MIN_WORD_TIMEOUT_MS,
  DIFFICULTY_CAST_DURATION_MS,
  DIFFICULTY_DAMAGE_ON_MISS,
  DIFFICULTY_WORD_TIMEOUT_MS,
  DIFFICULTY_SHOW_READING,
  PINYIN_HINT_BUDGET,
  FLASH_MS,
  PLAYER_DAMAGE_ON_FAIL,
  PLAYER_HEAL_ON_INTERRUPT,
  PLAYER_MAX_HP,
  SHATTER_MS,
  SKILLS,
  SKILL_COOLDOWN_MS,
  PRIMAL_RELEASE_HEAL,
  PRIMAL_RELEASE_DAMAGE_MULTIPLIER,
  TITAN_WRATH_ON_FAILURE_CHANCE,
  TITAN_WRATH_ON_SUCCESS_CHANCE,
  titanWrathChance,
  type CharacterId,
  type Difficulty,
  type GameMode,
  type InputMode,
} from '../battle/constants';
import { SkillButton } from '../components/SkillButton';
import { MechanicPanel } from '../components/MechanicPanel';
import { BossPanel } from '../components/BossPanel';
import { TypingField } from '../components/TypingField';
import { Avatar, type CombatText } from '../components/Avatar';
import { HpBar } from '../components/HpBar';
import { CountdownBar } from '../components/CountdownBar';
import { BattleExitControl } from '../components/BattleExitControl';

/** 词语复盘:这一局遇到过的词,打对了还是没打对(超时/跳过/放弃都算没打对) */
export interface WordReviewEntry {
  id: string;
  /** 显示原文,可能含中点,如 "必杀剑·九天" */
  text: string;
  reading: string;
  category: WordCategory;
  outcome: 'correct' | 'missed';
}

export interface SoloResult {
  victory: boolean;
  /** 非胜利时区分到底是血量归零秒结,还是单纯打到时间到 */
  reason: 'boss_defeated' | 'player_defeated' | 'time_up';
  score: number;
  /** 结算那一刻的剩余血量;血量归零判负时恒为 0 */
  playerHp: number;
  /** 这一局的血量上限。突然死亡模式是 1,其余都是 PLAYER_MAX_HP */
  maxHp: number;
  /** 突然死亡模式专用:强制不计入排行榜,不管难度/玩法本来符不符合上榜条件 */
  unranked: boolean;
  /** 每日挑战:非空表示这一局是当天的挑战,结算页要交到每日榜而不是正式榜 */
  dailyDateKey?: string;
  damage: number;
  interruptsSucceeded: number;
  interruptsFailed: number;
  stats: SessionStats;
  /**
   * 0..100 的可信度。单机是在客户端算的,**只能当作「本机自查」**:
   * 它挡得住随手写的自动化脚本(合成事件 isTrusted=false、击键间隔方差趋零、
   * 零退格、首键延迟恒定),挡不住认真改客户端的人。
   * ★ 成绩要上排行榜时,必须把 attempts 原样传给服务端重新跑一遍这两层校验 ——
   *   客户端算出来的这个分数本身不能作为上榜依据。
   */
  trustScore: number;
  trustFlags: string[];
  /**
   * 上榜时要交给服务端重放核算的原始材料。服务端拿 seed + categories + pureOnly
   * + difficulty 把这一局的词序列一模一样地重建出来,再逐条核对 attempts ——
   * 少任何一项都重建不出同一个序列,好人也会被判成作弊。
   */
  attempts: WordAttempt[];
  seed: string;
  mode: TypingMode;
  categories: WordCategory[];
  pureOnly: boolean;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  /** 无限模式专属:打倒了几只泰坦、扛了多久、最高连击 */
  endless?: {
    kills: number;
    survivedMs: number;
    maxCombo: number;
  };
  /** 这一局遇到过的所有词(去重,按第一次遇到的顺序),结算页「词语复盘」用 */
  wordsReview: WordReviewEntry[];
}

export interface SoloBattleProps {
  pool: WordEntry[];
  mode: TypingMode;
  difficulty: Difficulty;
  /** 已按难度收敛过的输入模式(地狱恒为 sequential),由调用方用 resolveInputMode 算好 */
  inputMode: InputMode;
  character: CharacterId;
  gameMode: GameMode;
  /** 这一局用了哪些分类、是否只要纯汉字 —— 服务端重放核算要靠它重建词池 */
  categories: WordCategory[];
  pureOnly: boolean;
  /**
   * 这一局的血量上限,不传就是 PLAYER_MAX_HP。突然死亡模式传 1——地狱难度
   * 任何一次失误(打错/超时/机制打断失败)扣血都 ≥1,血量上限压到 1 之后
   * 自然就是「打错一下就死」,不需要另开一套「即死」判定逻辑。
   * ★ 这个值同时也是回血(原初的解放/泰坦之怒打断成功)的封顶——只压低
   *   起始血量、不压低封顶的话,回几滴血就能吃掉一次失误,「打错就死」
   *   这条规则会被回血机制悄悄破坏掉。
   */
  maxHp?: number;
  /** 突然死亡模式专用:强制这一局不计入排行榜 */
  unranked?: boolean;
  /**
   * 挑战赛道的机制剧本(每日挑战/赛事用)。传了就**完全接管机制触发**:
   * 在剧本指定的词序号触发指定机制,不再掷骰子、不看 pity、不看血量阈值。
   * 不传就是普通模式,机制照旧随机——手感一行不改。
   *
   * ★ 为什么挑战赛道必须这样:机制的随机触发依赖玩家表现(打对/打错用不同
   *   基础概率、pity 计数器、血量阈值又取决于累计伤害),两个水平不同的人
   *   哪怕同一个 seed 也会从第一次失误起分叉。详见 packages/shared/src/challenge.ts。
   */
  challengeScript?: ChallengeScript;
  /**
   * 挑战赛道要用的固定 seed。不传就还是每局随机生成——只有固定下来,
   * 所有人才会拿到同一条词序列。
   */
  fixedSeed?: string;
  /** 每日挑战的日期键,原样带进结算结果,让结算页知道该交到哪个榜 */
  dailyDateKey?: string;
  onFinish: (result: SoloResult) => void;
  onExit: () => void;
}

interface EngineState {
  bossHp: number;
  playerHp: number;
  combo: number;
  currentWord: WordEntry | null;
  /**
   * 当前正在进行的 Boss 机制(泰坦之怒 / 三连桶 / 三穿一)。
   * 三个机制走同一条路径 —— 加新机制不需要再往这里加字段,
   * 见 packages/shared/src/mechanics.ts 顶部的说明。
   */
  mechanic: MechanicState | null;
  /** 机制的总时长,用于画进度条 */
  mechanicTotalMs: number;
  /** 机制插进来时被冻结的普通词,结束后原样恢复,不跳词 */
  pendingNormalWord: WordEntry | null;
  remainingMs: number;
  ended: boolean;
  avatarState: AvatarState;
  shattered: boolean;
  flash: boolean;
  interruptsSucceeded: number;
  interruptsFailed: number;
  totalDamage: number;
  combatTexts: CombatText[];
  /** 距上次泰坦之怒之后又结算了几个普通词。喂给 titanWrathChance 的保底计数器 */
  wordsSinceWrath: number;
  /** 技能可以再次使用的时刻(相对本局毫秒);0 表示现在就能用 */
  skillReadyAt: number;
  /** 「浴血」剩余覆盖几个词,0 表示没在增益里 */
  bloodbathWordsLeft: number;
  /** 「原初的解放」的追加效果是否挂在下一个词上:打成功才结算,打错/超时就作废 */
  primalReleaseArmed: boolean;
  /**
   * 这一局已经结算过几个普通词(打对打错都算)。挑战赛道靠它对齐剧本的
   * afterWord —— 机制在第几个词之后触发,和玩家打得怎么样无关。
   */
  normalWordsSettled: number;
  /** 无限模式:已经打倒几只泰坦 */
  kills: number;
  /** 无限模式:当前这只泰坦的血量上限(逐只加厚) */
  bossMaxHp: number;
  /** 无限模式的排行指标之一,标准模式也顺手记着 */
  maxCombo: number;
  /** 按 Q 键还能揭示几次拼音提示,0 表示这一局已经没有这个机会了 */
  pinyinHintsLeft: number;
  /** 当前这个词的拼音是不是已经被揭示过——换词/机制开始时要清掉 */
  pinyinRevealed: boolean;
  /**
   * 当前这次机制是什么时候开始的(相对本局毫秒),没在机制里时为 null。
   * 只用来算 CPM 该扣掉多少"非打字时间"——见 endMechanicTiming。
   */
  mechanicStartedAt: number | null;
}

/** 把毫秒格式化成 m:ss,无限模式的存活时长要一直看着,得好读 */
function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function initEngine(bossMaxHp: number, pinyinHintsLeft: number, maxHp: number): EngineState {
  return {
    bossHp: bossMaxHp,
    playerHp: maxHp,
    combo: 0,
    currentWord: null,
    mechanic: null,
    mechanicTotalMs: 0,
    pendingNormalWord: null,
    remainingMs: BATTLE_DURATION_MS,
    ended: false,
    avatarState: 'idle',
    shattered: false,
    flash: false,
    interruptsSucceeded: 0,
    interruptsFailed: 0,
    totalDamage: 0,
    combatTexts: [],
    wordsSinceWrath: 0,
    normalWordsSettled: 0,
    skillReadyAt: 0,
    bloodbathWordsLeft: 0,
    primalReleaseArmed: false,
    kills: 0,
    bossMaxHp,
    maxCombo: 0,
    pinyinHintsLeft,
    pinyinRevealed: false,
    mechanicStartedAt: null,
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
export function SoloBattle({
  pool, mode, difficulty, inputMode, character, gameMode, categories, pureOnly,
  maxHp = PLAYER_MAX_HP, unranked = false, challengeScript, fixedSeed, dailyDateKey,
  onFinish, onExit,
}: SoloBattleProps) {
  const isEndless = gameMode === 'endless';
  // 练习难度和无限模式一样没有狂暴倒计时——区别是练习打死这一只泰坦就通关,
  // 不会像无限模式那样立刻刷下一只。
  const noDurationLimit = isEndless || difficulty === 'practice';
  // Boss 血量按难度加厚:困难 +30%、地狱 +100%
  const bossMaxHp = bossHpFor(difficulty);
  const pinyinHintBudget = mode === 'hanzi' ? PINYIN_HINT_BUDGET[difficulty] : 0;
  const engineRef = useRef<EngineState>(initEngine(bossMaxHp, pinyinHintBudget, maxHp));
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((n) => n + 1);

  const castDurationMs = DIFFICULTY_CAST_DURATION_MS[difficulty];
  const baseWordTimeoutMs = DIFFICULTY_WORD_TIMEOUT_MS[difficulty];
  const showReading = DIFFICULTY_SHOW_READING[difficulty];
  const skill = SKILLS[character];

  /**
   * 「浴血」期间普通词限时收紧 25%,换词时按当时的增益状态重新算。
   * 无限模式再叠一层:每打倒一只泰坦,限时先按 ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS
   * 缩一截(有下限),「浴血」的收紧在这个已经缩过的值上再乘一次。
   */
  const wordTimeoutFor = (bloodbathActive: boolean) => {
    const base = isEndless
      ? Math.max(
          ENDLESS_MIN_WORD_TIMEOUT_MS,
          baseWordTimeoutMs - engineRef.current.kills * ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS,
        )
      : baseWordTimeoutMs;
    return Math.round(base * (bloodbathActive ? BLOODBATH_TIME_SCALE : 1));
  };

  const battleStartRef = useRef(performance.now());
  const now = () => performance.now() - battleStartRef.current;

  // 挑战赛道传了固定 seed 就用它——所有人同一条词序列的前提
  const seedRef = useRef(fixedSeed ?? `solo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  /**
   * 普通词池按难度分布筛过;打断词仍从传进来的完整 pool 里取 ——
   * 打断词必须是 ≤4 字的短词,而困难/地狱筛完最短就是 4 字,拿筛过的池去找短词
   * 很容易一个都找不到,泰坦之怒会静默失效。理由同 packages/shared/src/battle.ts
   * 里 pickShortInterruptWord 的注释。
   */
  const normalPoolRef = useRef(filterPoolByDifficulty(pool, difficulty));
  const queueRef = useRef(createWordQueue(normalPoolRef.current, seedRef.current));
  const attemptsRef = useRef<WordAttempt[]>([]);
  const targetsRef = useRef(new Map<string, string>());
  /** 累计花在机制上的真实时长(毫秒),结算时从 CPM 分母里扣掉——见 endMechanicTiming */
  const nonTypingMsRef = useRef(0);
  /**
   * 词语复盘:按 word.id 去重,同一个词重复出现时最新结果覆盖旧的。
   * 用 Map 是因为 JS 的 Map.set 在 key 已存在时不会挪动插入位置 ——
   * 覆盖结果的同时,列表仍按「第一次遇到」的顺序排列,不用另外记时间戳排序。
   */
  const reviewRef = useRef(new Map<string, WordReviewEntry>());
  function recordReview(word: WordEntry, outcome: WordReviewEntry['outcome']) {
    reviewRef.current.set(word.id, {
      id: word.id, text: word.text, reading: word.reading, category: word.category, outcome,
    });
  }
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
    endMechanicTiming(); // 兜底:阵亡/通关有可能刚好卡在机制进行中,resumeNormalWord 走不到
    const elapsed = now();
    const stats = computeStats(attemptsRef.current, elapsed, mode, targetsRef.current, nonTypingMsRef.current);
    const score = computeScore(e.totalDamage, e.interruptsSucceeded, stats.accuracy);

    // ── 反作弊:单机也要跑,而且必须跑 ──
    // 单机成绩同样能上排行榜(无限模式、困难/地狱标准模式),不跑这两层的话
    // 一个几十行的自动化脚本就能刷满榜。两层的分工见 packages/shared/src/anticheat.ts:
    //   checkAttempt   逐次硬校验(合成事件、时间线倒流、时钟偏移、粘贴)
    //   analyzeSession 整局击键节奏统计(方差、低间隔占比、首键延迟、直方图峰度)
    const hardFlags = new Set<string>();
    for (const a of attemptsRef.current) {
      const target = targetsRef.current.get(a.wordId);
      if (target === undefined) continue;
      // 单机没有服务端墙钟,用 attempt 自己的 submittedAt 当基准 —— 于是
      // clock_skew 这一条在单机天然不成立,真正起作用的是 untrusted_event、
      // time_travel 与 keystroke_deficit(粘贴检测)。
      const check = checkAttempt(a, { wordId: a.wordId, target }, a.submittedAt);
      if (!check.ok) check.flags.forEach((f) => hardFlags.add(f));
    }
    const trust = analyzeSession(attemptsRef.current, elapsed);
    const trustFlags = Array.from(new Set([...trust.flags, ...hardFlags]));
    onFinish({
      victory,
      reason,
      score,
      playerHp: e.playerHp,
      maxHp,
      unranked,
      dailyDateKey,
      damage: e.totalDamage,
      interruptsSucceeded: e.interruptsSucceeded,
      interruptsFailed: e.interruptsFailed,
      stats,
      trustScore: trust.trustScore,
      trustFlags,
      attempts: attemptsRef.current,
      seed: seedRef.current,
      mode,
      categories,
      pureOnly,
      gameMode,
      difficulty,
      inputMode,
      character,
      endless: isEndless
        ? { kills: e.kills, survivedMs: Math.round(now()), maxCombo: e.maxCombo }
        : undefined,
      wordsReview: Array.from(reviewRef.current.values()),
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
    e.mechanic = null;
    e.pendingNormalWord = null;
    e.pinyinRevealed = false;
    wordDeadlineRef.current = now() + wordTimeoutFor(e.bloodbathWordsLeft > 0);
  }

  /**
   * 机制(不管成功还是失败)结束时把这段真实耗时记进 nonTypingMsRef。
   * ★ 必须在所有"机制结束"的出口都调用到,包括战斗中途结束(击败/阵亡)那种
   *   没走到 resumeNormalWord 的情况——finish() 里也兜底调了一次,双重保险。
   */
  function endMechanicTiming() {
    const e = engineRef.current;
    if (e.mechanicStartedAt !== null) {
      nonTypingMsRef.current += now() - e.mechanicStartedAt;
      e.mechanicStartedAt = null;
    }
  }

  /**
   * 打断结束,回到被冻结的那个普通词并重新起限时。
   * 与联机保持同一套语义(见 apps/server/src/rooms/room.ts 的 resumeNormalWord):
   * 泰坦之怒是插进来的一次挑战,不消耗普通词队列,打完接着打原来那个词。
   */
  function resumeNormalWord() {
    const e = engineRef.current;
    if (e.ended) return;
    endMechanicTiming();
    e.mechanic = null;
    if (!e.pendingNormalWord) {
      drawNext();
      return;
    }
    e.currentWord = e.pendingNormalWord;
    e.pendingNormalWord = null;
    e.pinyinRevealed = false;
    wordDeadlineRef.current = now() + wordTimeoutFor(e.bloodbathWordsLeft > 0);
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

  /** extraMultiplier 目前只服务于「原初的解放」满血时的伤害翻倍,默认不生效 */
  function applyDamage(word: WordEntry, isInterrupt: boolean, extraMultiplier = 1) {
    const e = engineRef.current;
    const base = computeDamage(word.difficulty, e.combo, isInterrupt);
    // 「浴血」把奖惩一起放大:这里是奖励侧,扣血侧在 damagePlayer 里
    const bloodbathDmg = e.bloodbathWordsLeft > 0 ? Math.round(base * BLOODBATH_MULTIPLIER) : base;
    const dmg = extraMultiplier !== 1 ? Math.round(bloodbathDmg * extraMultiplier) : bloodbathDmg;
    e.bossHp = Math.max(0, e.bossHp - dmg);
    e.combo += 1;
    if (e.combo > e.maxCombo) e.maxCombo = e.combo;
    e.totalDamage += dmg;
    showCombatText('damage', dmg);
    e.avatarState = 'attack';
    scheduleRevert({ avatarState: 'idle' }, AVATAR_PULSE_MS);
    return dmg;
  }

  /** 扣血统一出口:「浴血」期间连挨打也加重,这是它的代价那一半 */
  function damagePlayer(amount: number): number {
    const e = engineRef.current;
    const scaled = e.bloodbathWordsLeft > 0 ? Math.round(amount * BLOODBATH_MULTIPLIER) : amount;
    const lostHp = Math.min(e.playerHp, scaled);
    e.playerHp -= lostHp;
    showCombatText('hurt', lostHp);
    e.flash = true;
    scheduleRevert({ flash: false }, FLASH_MS);
    return lostHp;
  }

  /**
   * 一个普通词结算完毕(不论打对打错)后统一走这里:推进保底计数器,并消耗一层
   * 「浴血」。打断词不算普通词,不走这个出口。
   */
  function consumeWordCounters(): void {
    const e = engineRef.current;
    e.wordsSinceWrath += 1;
    e.normalWordsSettled += 1;
    if (e.bloodbathWordsLeft > 0) e.bloodbathWordsLeft -= 1;
  }

  /**
   * 挑战赛道的机制触发:完全按剧本走,不掷任何骰子。
   *
   * 普通模式那两条路径(tryTriggerTitanWrath 掷概率+pity、tryTriggerHpMechanic
   * 看血量阈值)在挑战赛道里一条都不走 —— 它们都依赖玩家表现,会让同一个
   * seed 在不同人手里跑出不同的机制序列,挑战赛道就失去可比性了。
   *
   * @returns 有没有触发。调用方靠它决定要不要再走普通模式那套随机逻辑。
   */
  function tryTriggerScheduledMechanic(): boolean {
    if (!challengeScript) return false;
    const e = engineRef.current;
    if (e.mechanic || e.ended) return false;
    const id = mechanicAt(challengeScript, e.normalWordsSettled);
    if (!id) return false;
    beginMechanic(id);
    if (engineRef.current.mechanic) e.wordsSinceWrath = 0;
    return !!engineRef.current.mechanic;
  }

  /** 机制失败(超时或主动放弃):扣一份重伤害,回到被冻结的普通词 */
  function resolveMechanicFail() {
    const e = engineRef.current;
    // 三连桶会同时给出左右两个候选词,失败时说不清玩家看到的是哪一个,
    // 两个都记为「没打对」——反正两个都在屏幕上出现过。
    if (e.mechanic) currentMechanicWords(e.mechanic).forEach((w) => recordReview(w, 'missed'));
    e.interruptsFailed += 1;
    damagePlayer(PLAYER_DAMAGE_ON_FAIL);
    audio.play('hurt');
    if (checkDeath()) return;
    resumeNormalWord();
    rerender();
  }

  function resolveNormalMiss() {
    const e = engineRef.current;
    // 超时/放弃/地狱模式打错都从这里(或 resolveMiss 转手)统一结算,
    // 在 drawNext 换词之前记一笔,词语复盘才能覆盖到「没打对」的词。
    if (e.currentWord) recordReview(e.currentWord, 'missed');
    e.combo = 0;
    // 「原初的解放」的追加效果只认「下一个词打成功」——这次没打成功,增益作废,
    // 不会留到再下一个词上。
    e.primalReleaseArmed = false;
    e.avatarState = 'miss';
    scheduleRevert({ avatarState: 'idle' }, AVATAR_PULSE_MS);
    audio.play('miss');
    damagePlayer(DIFFICULTY_DAMAGE_ON_MISS[difficulty]);
    if (checkDeath()) return;
    consumeWordCounters();
    drawNext();
    // 同 handleComplete:挑战赛道只认剧本
    if (!tryTriggerScheduledMechanic() && !challengeScript) {
      tryTriggerTitanWrath(TITAN_WRATH_ON_FAILURE_CHANCE);
    }
    rerender();
  }

  /**
   * 泰坦之怒只由一次普通词结算随机触发,绝不再用定时器抢断正在输入的词。
   * 实际概率由 titanWrathChance 在基础值上叠保底(词数越多越容易出)并施加
   * 触发后的冷却窗口——地狱难度不吃那层冷却。
   */
  function tryTriggerTitanWrath(baseChance: number): boolean {
    const e = engineRef.current;
    const chance = titanWrathChance(baseChance, e.wordsSinceWrath, difficulty);
    if (Math.random() >= chance) return false;
    beginMechanic('titan_wrath');
    if (engineRef.current.mechanic) e.wordsSinceWrath = 0; // 触发了才重置保底
    return !!engineRef.current.mechanic;
  }

  /**
   * Boss 掉血后检查血量阈值类机制(三连桶 67% / 三穿一 33%)。
   *
   * 标准模式用 MECHANICS 里各自登记的阈值、必定触发;无限模式改用
   * ENDLESS_MECHANIC_THRESHOLDS 的四个点各自掷骰子 —— 一只接一只地刷,
   * 固定流程会腻。两种模式都只在「跨过」阈值的那一刻触发一次。
   */
  function tryTriggerHpMechanic(prevHp: number, curHp: number): void {
    const e = engineRef.current;
    if (e.mechanic || e.ended || e.bossMaxHp <= 0) return;
    const prevRatio = prevHp / e.bossMaxHp;
    const curRatio = curHp / e.bossMaxHp;

    if (isEndless) {
      if (crossedThresholds(ENDLESS_MECHANIC_THRESHOLDS, prevRatio, curRatio).length === 0) return;
      if (Math.random() >= ENDLESS_MECHANIC_CHANCE) return;
      // 无限模式不绑定「哪个阈值出哪个机制」,两个轮着来更有变化
      beginMechanic(e.kills % 2 === 0 ? 'three_barrels' : 'three_pierce');
      return;
    }
    const id = mechanicForHpDrop(prevRatio, curRatio, Math.random());
    if (id) beginMechanic(id);
  }

  /** 打错/跳过/超时,统一入口——机制进行中就走机制失败,否则走普通词失败 */
  function resolveMiss() {
    const e = engineRef.current;
    if (e.mechanic) {
      e.combo = 0;
      resolveMechanicFail();
    } else {
      resolveNormalMiss();
    }
  }

  /**
   * 泰坦被打倒。标准模式到此通关;无限模式则立刻刷下一只 —— 血量按
   * ENDLESS_BOSS_HP_GROWTH 逐只加厚,并回一点血作为奖励(没有这个奖励,
   * 无限模式就变成纯消耗,死因永远是血量而不是手速)。
   *
   * @returns 战斗是否还要继续。false 表示已经结束,调用方应立即 return。
   */
  function onBossDefeated(): boolean {
    const e = engineRef.current;
    audio.play('victory');
    if (!isEndless) {
      e.ended = true;
      rerender();
      finish(true, 'boss_defeated');
      return false;
    }
    e.kills += 1;
    e.mechanic = null; // 换 Boss 时清掉进行中的机制,避免跨 Boss 悬着
    queueRef.current.reset(); // 换新 Boss,单独重洗一副牌——保证"这一只"打过程中不重词
    e.bossMaxHp = Math.round(e.bossMaxHp * ENDLESS_BOSS_HP_GROWTH);
    e.bossHp = e.bossMaxHp;
    // ★ 玩家血量全程只有一条,不随击杀刷新——泰坦的血条换新是"下一只"天经地义,
    //   但玩家的血是"这一整局"的资源,击杀奖励额外回血会让状态好的人感觉不到消耗,
    //   变相把无限模式拖到几乎打不死。要回血只能靠机制/技能挣。
    e.shattered = true;
    scheduleRevert({ shattered: false }, SHATTER_MS);
    return true;
  }

  function handleComplete(payload: {
    wordId: string;
    submitted: string;
    keystrokes: WordAttempt['keystrokes'];
    backspaces: number;
    compositionCommits: number;
    focusLostMs: number;
    startedAt: number;
    submittedAt: number;
  }) {
    const e = engineRef.current;
    if (e.ended) return;

    // ── 机制进行中:交给 mechanics.ts 的状态机推进 ──
    if (e.mechanic) {
      // 提交前先按 wordId 把命中的那个词找出来——submitMechanicWord 之后
      // 状态就推进了,三连桶打完左词右词候选会跟着换,再找就找不到原来那个了。
      const hitWord = currentMechanicWords(e.mechanic).find((w) => w.id === payload.wordId);
      const outcome = submitMechanicWord(e.mechanic, payload.wordId);
      if (outcome.kind === 'rejected') {
        // 三连桶打错方向 / 三穿一打错顺序:原地不动,清空输入让玩家重打,
        // 计时不停 —— 这是需求明确要的惩罚力度,不扣血也不直接失败。
        audio.play('miss');
        resetTyping();
        rerender();
        return;
      }
      if (hitWord) recordReview(hitWord, 'correct');
      if (outcome.kind === 'progress') {
        e.mechanic = outcome.state;
        audio.play('hit_slash');
        resetTyping();
        rerender();
        return;
      }
      // cleared:整个机制完成
      resolveMechanicSuccess(payload);
      return;
    }

    // ── 普通词 ──
    if (!e.currentWord) return;
    const word = e.currentWord;
    attemptsRef.current.push({ ...payload, wordId: word.id });
    // 打对了就把「实际打的这串」记成这个词的判定文本——拼音模式下玩家可能
    // 命中的是某个多音字的容错读音变体(见 battle.ts 的 HIGH_RISK_POLYPHONES),
    // 不一定是 targetOf 算出来的那个"标准答案",但 status===complete 已经
    // 证明它是被接受的正确答案,直接拿它当参照最准确,不用再猜是哪个变体命中的。
    targetsRef.current.set(word.id, payload.submitted);
    recordReview(word, 'correct');

    const prevBossHp = e.bossHp;
    // 「原初的解放」的追加效果只结算这一次:满血翻倍伤害,没满血就回血。
    const primalArmed = e.primalReleaseArmed;
    e.primalReleaseArmed = false;
    const primalFullHp = primalArmed && e.playerHp >= maxHp;
    applyDamage(word, false, primalFullHp ? PRIMAL_RELEASE_DAMAGE_MULTIPLIER : 1);
    if (primalArmed && !primalFullHp) {
      e.playerHp = Math.min(maxHp, e.playerHp + PRIMAL_RELEASE_HEAL);
    }
    audio.play('hit_slash');

    if (e.bossHp <= 0 && !onBossDefeated()) return;
    consumeWordCounters();
    drawNext();
    // 挑战赛道:机制完全按剧本,不走下面那两条依赖玩家表现的随机路径
    if (!tryTriggerScheduledMechanic() && !challengeScript) {
      // 先看这次掉血有没有跨过机制阈值,没有再掷泰坦之怒的骰子 ——
      // 阈值类机制是「剧情节点」,优先级高于随机插入的泰坦之怒。
      tryTriggerHpMechanic(prevBossHp, e.bossHp);
      if (!e.mechanic) tryTriggerTitanWrath(TITAN_WRATH_ON_SUCCESS_CHANCE);
    }
    rerender();
  }

  /** 机制完成:统一给一次打断级奖励(伤害 + 回血),再回到被冻结的普通词 */
  function resolveMechanicSuccess(payload: { wordId: string; submitted: string;
    keystrokes: WordAttempt['keystrokes']; backspaces: number; compositionCommits: number;
    focusLostMs: number; startedAt: number; submittedAt: number; }) {
    const e = engineRef.current;
    const words = e.mechanic ? currentMechanicWords(e.mechanic) : [];
    const word = words.find((x) => x.id === payload.wordId) ?? words[0] ?? e.currentWord;
    const prevBossHp = e.bossHp;
    if (word) {
      attemptsRef.current.push({ ...payload, wordId: word.id });
      // 同上面普通词分支的理由:记实际命中的那一串,兼容拼音多音字容错变体
      targetsRef.current.set(word.id, payload.submitted);
      applyDamage(word, true);
    }
    e.interruptsSucceeded += 1;
    e.shattered = true;
    scheduleRevert({ shattered: false }, SHATTER_MS);
    audio.play('interrupt');
    e.playerHp = Math.min(maxHp, e.playerHp + PLAYER_HEAL_ON_INTERRUPT);

    if (e.bossHp <= 0 && !onBossDefeated()) return;
    resumeNormalWord();
    // ★ 机制成功这一下也要查血量阈值。打断伤害带 2.5 倍加成,一击跨过一整个
    //   阈值区间是常事 —— 少了这句,33% 的三穿一会被「67% 的三连桶刚打完就把血
    //   打到 30%」这种情况整个跳过,而且不报任何错。
    tryTriggerHpMechanic(prevBossHp, e.bossHp);
    rerender();
  }

  /**
   * 主动技能。两个角色各一个,冷却 SKILL_COOLDOWN_MS(一局约能开两次)。
   * 打断期间不能开 —— 技能是围绕普通词设计的,读条阶段放行会让「原初的解放」
   * 变成白嫖打断,那是另一个量级的强度。
   */
  function canUseSkill(): boolean {
    const e = engineRef.current;
    return !e.ended && !e.mechanic && !!e.currentWord && now() >= e.skillReadyAt;
  }

  function useSkill() {
    const e = engineRef.current;
    if (!canUseSkill()) return;
    e.skillReadyAt = now() + SKILL_COOLDOWN_MS;

    if (character === 'p1') {
      // 原初的解放:换掉当前词,连击不断,**不对 Boss 造成任何伤害**。
      // 不记 attempt(没有真正打完这个词),也不推进保底计数器——它不是一次结算。
      // 换出来的这个新词挂上追加效果:打成功回血,满血则改为那个词伤害翻倍。
      audio.play('interrupt');
      drawNext();
      e.primalReleaseArmed = true;
    } else {
      // 浴血:接下来 BLOODBATH_WORDS 个词奖惩同放大,并收紧限时。
      // 立刻按新的限时重算当前词的截止时刻,不然增益要等到换词才生效。
      e.bloodbathWordsLeft = BLOODBATH_WORDS;
      audio.play('interrupt');
      wordDeadlineRef.current = now() + wordTimeoutFor(true);
    }
    rerender();
  }

  function handleSkip() {
    const e = engineRef.current;
    if (e.ended) return;
    // 机制进行中放弃:直接判机制失败,不记 attempt(此刻没有「当前普通词」可记)
    if (e.mechanic) {
      resolveMechanicFail();
      return;
    }
    if (!e.currentWord) return;
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

  /**
   * 开一次机制。所有机制都走这一个入口 —— 加新机制不必再写一个 beginXxx,
   * 只要在 mechanics.ts 里登记好就行。
   *
   * ★ 机制词从**没按难度筛过的完整 pool** 里取:机制都是短时挑战、要短词,
   *   而困难/地狱的普通词池掐掉了 2 字词,拿它选很容易一个都选不到。
   */
  function beginMechanic(id: MechanicId) {
    const e = engineRef.current;
    if (e.ended || e.mechanic) return;
    // ★ 挑战赛道下机制词和三连桶出生方向都必须由 seed + 第几个词推出来,
    //   不能带墙钟时间和 Math.random —— 那样同一个 seed 每次跑出来的机制都不同,
    //   正是挑战赛道要消除的东西。普通模式沿用原来的写法,手感不变。
    const mechSeed = challengeScript
      ? challengeMechanicSeed(seedRef.current, e.normalWordsSettled)
      : `${seedRef.current}:${id}:${Math.floor(now())}`;
    const mechRoll = challengeScript
      ? challengeMechanicRoll(seedRef.current, e.normalWordsSettled)
      : Math.random();
    const state = createMechanicState(id, pool, difficulty, now(), mechSeed, mechRoll);
    if (!state) {
      rerender();
      return;
    }
    // 普通词冻结在原地,机制结束后由 resumeNormalWord 原样接回
    e.pendingNormalWord = e.currentWord;
    wordDeadlineRef.current = null;
    e.mechanic = state;
    e.mechanicStartedAt = now();
    e.mechanicTotalMs = mechanicDurationMs(id, difficulty);
    // 拼音提示只服务普通词——机制是短时挑战,不给这个机会,揭示状态也不该
    // 从冻结前的普通词那里漏过来。
    e.pinyinRevealed = false;
    rerender();
  }

  /**
   * 按 Q 揭示当前普通词的拼音,每局限量(PINYIN_HINT_BUDGET,按难度定)。
   * 只对普通词生效——机制进行中不给用,理由同 useSkill 的注释:机制是围绕
   * 短时挑战设计的,不该被普通词的辅助机制波及。
   */
  function revealPinyinHint(): void {
    const e = engineRef.current;
    if (e.ended || e.mechanic || !e.currentWord) return;
    if (e.pinyinRevealed || e.pinyinHintsLeft <= 0) return;
    e.pinyinHintsLeft -= 1;
    e.pinyinRevealed = true;
    rerender();
  }

  function tick() {
    const e = engineRef.current;
    if (e.ended) return;
    const elapsed = now();
    e.remainingMs = noDurationLimit ? elapsed : Math.max(0, BATTLE_DURATION_MS - elapsed);

    if (e.mechanic && elapsed >= e.mechanic.deadline) {
      resolveMechanicFail();
      return;
    }
    if (!e.mechanic && wordDeadlineRef.current !== null && elapsed >= wordDeadlineRef.current) {
      wordDeadlineRef.current = null;
      resolveNormalMiss();
      return;
    }
    // 无限模式、练习难度都没有狂暴倒计时;上面那行 remainingMs 这时被当成
    // 「已用时」用于展示,不参与结束判定——无限模式只看血量归零,练习模式
    // 只看泰坦有没有被打死。
    if (!noDurationLimit && e.remainingMs <= 0) {
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

  // 机制进行中打的是机制的词(三连桶同时给左右两个,打哪个都算数),
  // 否则打普通词。两者共用同一个输入框与同一套 IME 处理。
  const mechanicWords = e.mechanic ? currentMechanicWords(e.mechanic) : [];
  const activeEntry = mechanicWords[0] ?? e.currentWord;
  // 拼音模式:词库读音是脚本批量生成的,生僻专名常猜错多音字——把「逻辑上的
  // 目标词」展开成所有可接受的读音变体喂给 candidates,判定容错见 battle.ts
  // 里 HIGH_RISK_POLYPHONES 的说明。汉字模式没有这个问题,不需要展开。
  const logicalTargets = mechanicWords.length > 0 ? mechanicWords : e.currentWord ? [e.currentWord] : [];
  const typingCandidates = mode === 'pinyin' ? expandPinyinCandidates(logicalTargets)
    : mechanicWords.length > 0 ? mechanicWords : undefined;

  const { state: typingState, inputRef, inputProps, reset: resetTyping } = useTypingInput({
    entry: activeEntry,
    candidates: typingCandidates,
    mode,
    now,
    onComplete: handleComplete,
    disabled: e.ended,
  });

  useEffect(() => {
    inputRef.current?.focus();
    // 移动端软键盘弹起后可视区只剩一半,输入框可能被顶到看不见的地方。
    // 多数浏览器聚焦时会自己滚,但行为不一致(尤其 Android WebView),
    // 显式滚一次最省事;桌面端 pointer 不是 coarse,不会执行到这里。
    if (window.matchMedia('(pointer: coarse)').matches) {
      inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [activeEntry?.id]);

  // 逐字输入:一个字打错就立刻结算,不等玩家退格重试或按 Enter。
  // 用 typingState 的对象引用去重——React 18 StrictMode 在开发环境下会把
  // 依赖没变的 effect 再多跑一次(mount -> cleanup -> mount)来揪有没有
  // 忘写清理函数的 bug,这个 effect 本身没有清理函数、又是非幂等的副作用
  // (会扣血、切词),不去重的话开发环境下一次失误会顶两次算。
  //
  // ★ 组合输入完全不进这个分支:错了只把输入框染红(交给 TypingField 的
  //   status class),既不判负也不清空,玩家自己退格改到绿为止。
  const autoFailedStateRef = useRef<typeof typingState | null>(null);
  useEffect(() => {
    if (inputMode === 'composed') return;
    if (typingState.status === 'error' && autoFailedStateRef.current !== typingState) {
      autoFailedStateRef.current = typingState;
      if (difficulty === 'hell') handleSkip();
      else resetTyping();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typingState.status, inputMode]);

  function onKeyDown(ev: KeyboardEvent<HTMLInputElement>) {
    inputProps.onKeyDown(ev);

    // Tab 开技能。打字游戏里两只手都在键盘上,为开技能去点鼠标等于放弃这几秒输入。
    // 选 Tab 的理由:左手小指不用离开home区就能够到,而且中文输入法用数字键和
    // 空格选词、不占用 Tab。必须 preventDefault —— 否则焦点会跳出输入框,
    // 之后打的字全都进不去。
    // isComposing 时放行给输入法:少数输入法在候选状态下用 Tab 翻页,
    // 这时候抢走它会让人没法选词。
    if (ev.key === 'Tab' && !ev.nativeEvent.isComposing) {
      ev.preventDefault();
      useSkill();
      return;
    }

    // Q 揭示拼音提示。★ 只在汉字模式下拦截——拼音模式里 q 是玩家要打进输入框
    // 的合法拼音字母(七/去/青……),抢在这里会直接打断输入。isComposing 判断
    // 挡住的是中文输入法用拼音字母敲汉字候选的那一瞬间,理由同上面的 Tab。
    if (mode === 'hanzi' && ev.key.toLowerCase() === 'q' && !ev.nativeEvent.isComposing) {
      ev.preventDefault();
      revealPinyinHint();
      return;
    }

    // 组合输入下 Enter 不做任何事:玩家可能刚打完一长串正要回头改,
    // 这时候把输入清掉是最气人的行为。
    if (inputMode === 'composed') return;
    if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
      if (difficulty === 'hell') handleSkip();
      else resetTyping();
    }
  }

  return (
    <div className={`battle${e.flash ? ' battle--flash' : ''}`}>
      <BossPanel
        name={isEndless ? `${BOSS_NAME} · 第 ${e.kills + 1} 只` : BOSS_NAME}
        hp={e.bossHp}
        maxHp={e.bossMaxHp}
        cast={
          e.mechanic
            ? {
                skillName: MECHANICS[e.mechanic.id].name,
                word: mechanicWords[0] ?? null,
                startedAt: e.mechanic.deadline - e.mechanicTotalMs,
                castMs: e.mechanicTotalMs,
              }
            : null
        }
        shattered={e.shattered}
      />

      <div className="battle__mid">
        <div className="battle__player-status">
          <HpBar value={e.playerHp} max={maxHp} variant="player" />
          {isEndless ? (
            <div className="battle__endless-stat">
              已存活 {formatDuration(e.remainingMs)} · 已击倒 <strong>{e.kills}</strong> 只
            </div>
          ) : difficulty === 'practice' ? (
            <div className="battle__endless-stat">已用时 {formatDuration(e.remainingMs)} · 不限时,慢慢打</div>
          ) : (
            <CountdownBar label="狂暴倒计时" remainingMs={e.remainingMs} totalMs={BATTLE_DURATION_MS} variant="enrage" />
          )}
          {!e.mechanic && wordDeadlineRef.current !== null && (
            <CountdownBar
              label="普通词倒计时"
              remainingMs={Math.max(0, wordDeadlineRef.current - now())}
              totalMs={wordTimeoutFor(e.bloodbathWordsLeft > 0)}
              variant="word"
            />
          )}
        </div>
      </div>

      {e.mechanic && (
        <MechanicPanel
          state={e.mechanic}
          remainingMs={Math.max(0, e.mechanic.deadline - now())}
          totalMs={e.mechanicTotalMs}
        />
      )}

      <TypingField
        entry={activeEntry}
        alternatives={mechanicWords.length > 1 ? mechanicWords : undefined}
        status={typingState.status}
        matchedLength={typingState.matchedLength}
        mode={mode}
        inputProps={{ ...inputProps, ref: inputRef, onKeyDown }}
        isInterrupt={!!e.mechanic}
        showReading={showReading || e.pinyinRevealed}
        inputMode={inputMode}
      />
      {pinyinHintBudget > 0 && !e.mechanic && (
        <div className="battle__pinyin-hint">
          {e.pinyinHintsLeft > 0
            ? <>按 <kbd>Q</kbd> 查看这个词的拼音 · 本局还剩 {e.pinyinHintsLeft}/{pinyinHintBudget} 次</>
            : '拼音提示已经用完了'}
        </div>
      )}
      <div className="battle__actions">
        <SkillButton
          skill={skill}
          readyAt={e.skillReadyAt}
          now={now}
          disabled={!canUseSkill()}
          onUse={useSkill}
        />
        <button className="battle__skip" type="button" disabled={e.ended} onClick={handleSkip}>
          {e.mechanic ? `放弃${MECHANICS[e.mechanic.id].name}` : '放弃当前词'}
        </button>
      </div>
      {e.bloodbathWordsLeft > 0 && (
        <div className="battle__buff">浴血 · 剩余 {e.bloodbathWordsLeft} 词(奖惩 ×{BLOODBATH_MULTIPLIER},限时 -25%)</div>
      )}
      <BattleExitControl onConfirm={onExit} />

      <div className="battle__avatar-row">
        <div className="battle__side">
          <div className="battle__side-combo">连击 x{e.combo}</div>
          <Avatar state={e.avatarState} nick="你" isSelf slot={character} combatTexts={e.combatTexts} />
        </div>
      </div>
      <p className="battle__hint">
        {inputMode === 'composed'
          ? '组合输入:打错不会立刻判负,输入框变红时退格改到变绿即可;普通词超时仍会扣血。'
          : '逐字输入:打错立刻结算(地狱直接判负,其余清空重来);普通词超时会扣血。'}
      </p>
    </div>
  );
}
