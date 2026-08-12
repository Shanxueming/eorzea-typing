/**
 * 单个房间的状态机:大厅 -> 战斗 -> 结束。
 *
 * 服务端权威:客户端乐观预测(本地立即判定并推进到下一个词),
 * 服务端独立维护每个玩家的词队列(与客户端用同一个 seed 生成,序列必然一致)
 * 只用来核对 word_attempt 里的 wordId/submitted 是否对得上——真正花钱的伤害、
 * 血量、结算全部以服务端这份为准。
 *
 * M4:每次 word_attempt 先过 checkAttempt 的一致性硬校验(时间线、trusted
 * 事件、粘贴检测),不通过就该次记 0 分并记下 flag,继续走后面的判定不算数;
 * 局末再用 analyzeSession 跑一遍整局的击键节奏统计,给出 trustScore/flags。
 *
 * ★ 血条机制(用户要求的第二轮设计):
 *   - 联机两人共用一条血条(不是各自一条),归零直接判负、战斗立即结束,
 *     不再有"倒地 5 秒复活"那一套。
 *   - 打错普通词、打断/躲避失败都扣血;打断成功额外回一点血。
 *   - 普通词现在也限时了(读条时长的 2.5 倍),超时按 miss 处理。
 *   - 读条开始前有 1 秒预警(boss_cast_warning),预警阶段还打不了。
 */
import { nanoid } from 'nanoid';
import type { WordAttempt, WordEntry, BattleConfig, PlayerResult } from '@eorzea/shared/types';
import { computeDamage, computeScore, computeStats, targetOf } from '@eorzea/shared/scoring';
import { randomCategories, selectPool } from '@eorzea/shared/wordbank';
import { checkAttempt, analyzeSession } from '@eorzea/shared/anticheat';
import {
  bossHpFor,
  createWordQueue,
  filterFeaturedWordPool,
  filterPoolByDifficulty,
  resolveInputMode,
  titanWrathChance,
  BLOODBATH_MULTIPLIER,
  BLOODBATH_TIME_SCALE,
  BLOODBATH_WORDS,
  PRIMAL_RELEASE_HEAL,
  PRIMAL_RELEASE_DAMAGE_MULTIPLIER,
  SKILL_COOLDOWN_MS,
  ENDLESS_DIFFICULTY,
  ENDLESS_BOSS_HP_GROWTH,
  ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS,
  ENDLESS_MIN_WORD_TIMEOUT_MS,
  type WordQueue,
  type CharacterId,
  type Difficulty,
  type GameMode,
  type InputMode,
  BOSS_MAX_HP,
  BATTLE_DURATION_MS,
  CAST_INTERVAL_MS,
  DIFFICULTY_CAST_DURATION_MS,
  DIFFICULTY_DAMAGE_ON_MISS,
  DIFFICULTY_WORD_TIMEOUT_MS,
  PLAYER_MAX_HP,
  PLAYER_DAMAGE_ON_FAIL,
  PLAYER_HEAL_ON_INTERRUPT,
  BOSS_SKILL_NAME,
  TITAN_WRATH_ON_FAILURE_CHANCE,
  TITAN_WRATH_ON_SUCCESS_CHANCE,
} from '@eorzea/shared/battle';
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
import { ALLOW_SYNTHETIC_INPUT } from '../devFlags.js';
import { loadAllCategories, loadBank, loadBanks } from './wordbankStore.js';
import {
  send, type ConnectedPlayer, type CoopLeaderboardOutcome, type PlayerPublic, type PlayerTick, type S2C,
} from './protocol.js';
import { RANKED_DIFFICULTIES } from '../db/scores.js';
import { normalizePair, submitCoopScore } from '../db/coopScores.js';
import type { WebSocket } from 'ws';

interface PlayerBattleState {
  queue: WordQueue;
  currentWord: WordEntry | null;
  isInterrupt: boolean;
  combo: number;
  damage: number;
  wordsCompleted: number;
  misses: number;
  interruptsSucceeded: number;
  interruptsFailed: number;
  keystrokesTotal: number;
  backspacesTotal: number;
  attempts: WordAttempt[];
  targets: Map<string, string>;
  /** checkAttempt 硬校验命中的 flag,局末并入 analyzeSession 的统计 flags 一起展示 */
  hardFlags: Set<string>;
  /** 普通词限时计时器,机制期间不跑这个,由 beginMechanic 清掉 */
  wordTimer: ReturnType<typeof setTimeout> | null;
  /** 技能可再次使用的时刻(相对本局毫秒) */
  skillReadyAt: number;
  /** 「浴血」剩余覆盖几个词 */
  bloodbathWordsLeft: number;
  /** 「原初的解放」的追加效果是否挂在下一个词上:打成功才结算,打错/超时就作废 */
  primalReleaseArmed: boolean;
}

/**
 * 进行中的机制。
 *
 * ★ 两种语义并存,靠 `shared` 区分:
 *   - 共享型(泰坦之怒):任一玩家打对就算全队躲过,大家一起结束。
 *   - 独立型(三连桶/三穿一):**每人一份状态、各自判定**(需求明确要求),
 *     谁没在时限内完成谁吃一份伤害;全员完成则提前结束。
 */
interface PendingMechanic {
  mechanicId: MechanicId;
  shared: boolean;
  /** playerId -> 该玩家当前的机制状态。已完成的人从这里移除 */
  states: Map<string, MechanicState>;
  cleared: Set<string>;
  /**
   * 独立型机制专用:哪些人已经单独结算过奖惩、放回普通词了。
   * resolveMechanic 最终清算(超时兜底)时要跳过他们,不能再罚/奖一遍。
   */
  resolvedEarly: Set<string>;
  /** 机制开始那一刻的 Boss 血量,最终清算时用来检查有没有跨过下一档阈值 */
  bossHpAtStart: number;
  deadline: number;
  totalMs: number;
}

/** 昵称展示上限,超出部分截断,避免超长串把对手的界面撑坏 */
const MAX_NICK_LENGTH = 16;

export class Room {
  readonly code: string;
  players: ConnectedPlayer[] = [];
  phase: 'lobby' | 'battle' | 'ended' = 'lobby';
  /** 开房时刻。联机大厅按它排序,让刚开的房排在前面 */
  readonly createdAt = Date.now();
  /** 要不要出现在联机大厅列表里。私密房只能靠房间码进 */
  isPublic = true;

  private onEmpty: () => void;
  private battleStartedAt = 0;
  private seed = '';
  /** 这一局的普通词池,已按难度分布筛过 */
  private pool: WordEntry[] = [];
  /**
   * 打断词池:只过 filterFeaturedWordPool,**不按难度筛**。
   * 打断词必须是 ≤4 字的短词,而困难/地狱的普通词池最短就是 4 字,拿它去找
   * 短词很容易一个都找不到,泰坦之怒会从此静默失效。打断的难度体现在读条窗口
   * (DIFFICULTY_CAST_DURATION_MS)上,不在字数上。
   */
  private interruptPool: WordEntry[] = [];
  private config: BattleConfig | null = null;
  private bossHp = 0;
  private bossMaxHp = 0;
  private teamHp = 0;
  private castDurationMs = DIFFICULTY_CAST_DURATION_MS.normal;
  private normalWordTimeoutMs = DIFFICULTY_WORD_TIMEOUT_MS.normal;
  private difficulty: Difficulty = 'normal';
  private inputMode: InputMode = 'sequential';
  private gameMode: GameMode = 'standard';
  /** 房主开局时勾没勾"上传成绩到排行榜"——真正上不上还要看双方是否登录、成绩够不够格 */
  private submitScoreRequested = false;
  /** 无限模式:打倒了几只泰坦(标准模式恒为 0) */
  private kills = 0;
  /**
   * 泰坦之怒保底计数器:距上次触发之后全房又结算了几个普通词。
   * **全房一份**,不是每人一份 —— 泰坦之怒本来就是全房共享的一次事件,
   * 每人各攒一份会让两人局的实际触发频率直接翻倍。
   */
  private wordsSinceWrath = 0;
  private battleState = new Map<string, PlayerBattleState>();
  private pendingMechanic: PendingMechanic | null = null;
  private mechanicTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;

  constructor(code: string, onEmpty: () => void) {
    this.code = code;
    this.onEmpty = onEmpty;
  }

  private now(): number {
    return Date.now() - this.battleStartedAt;
  }

  /**
   * 反作弊硬校验的统一出口。
   *
   * 测试开关 ALLOW_SYNTHETIC_INPUT 只放行 `untrusted_event` 这**一条**
   * (自动化脚本发的合成事件),时间线倒流、时钟偏移、粘贴检测一条不少 ——
   * 它是为了让 E2E 能跑通联机对局,不是为了让作弊变容易。默认关闭。
   */
  private verifyAttempt(attempt: WordAttempt, wordId: string, target: string, nowMs: number) {
    const check = checkAttempt(attempt, { wordId, target }, nowMs);
    if (!ALLOW_SYNTHETIC_INPUT) return check;
    const flags = check.flags.filter((f) => f !== 'untrusted_event');
    return { ok: flags.length === 0, flags };
  }

  publicPlayers(): PlayerPublic[] {
    // 第一个加入的玩家就是房主,不用额外存字段
    return this.players.map((p, i) => ({
      playerId: p.playerId, nick: p.nick, ready: p.ready, isHost: i === 0, character: p.character,
      displayId: p.displayId,
    }));
  }

  /**
   * 联机大厅列出这间房时用的公开信息。
   *
   * ★ 只暴露"要不要进这间房"所必需的东西:房间码、房主昵称、人数、开房时间。
   *   **不带 displayId(账号 ID)** —— 大厅是不需要登录就能看的公开列表,把
   *   账号 ID 摊在上面等于允许任何人枚举在线玩家的账号,登录接口就有了一份
   *   现成的用户名字典。昵称是玩家自己随便起的,不构成这个问题。
   */
  lobbyInfo(): { code: string; hostNick: string; playerCount: number; createdAt: number } {
    return {
      code: this.code,
      // 第一个加入的就是房主,口径同 publicPlayers
      hostNick: this.players[0]?.nick ?? '',
      playerCount: this.players.length,
      createdAt: this.createdAt,
    };
  }

  /** 还能不能被大厅列出来:公开、在大厅阶段、没满员、且确实还有人在里面 */
  isJoinableFromLobby(): boolean {
    return this.isPublic && this.phase === 'lobby' && this.players.length > 0 && this.players.length < 2;
  }

  broadcast(msg: S2C): void {
    for (const p of this.players) send(p.ws, msg);
  }

  addPlayer(nick: string, ws: WebSocket, account: { id: string; displayId: string } | null = null): ConnectedPlayer {
    if (this.players.length >= 2 || this.phase !== 'lobby') {
      throw new Error('room_full');
    }
    const player: ConnectedPlayer = {
      playerId: nanoid(8),
      nick: nick.slice(0, MAX_NICK_LENGTH),
      ws,
      ready: false,
      connected: true,
      accountId: account?.id ?? null,
      displayId: account?.displayId ?? null,
      disconnectTimer: null,
      eliminated: false,
      character: 'p1',
    };
    this.players.push(player);
    return player;
  }

  /** 大厅里选角色。两人可以选同一个 —— 合作模式没必要抢 */
  handleSelectCharacter(playerId: string, character: CharacterId): void {
    if (this.phase !== 'lobby') return;
    const p = this.players.find((x) => x.playerId === playerId);
    if (!p) return;
    p.character = character;
    this.broadcast({ t: 'room_update', players: this.publicPlayers() });
  }

  /** 非房主点「准备」;房主不需要走这条(房主直接点开始) */
  handleReady(playerId: string): void {
    const p = this.players.find((x) => x.playerId === playerId);
    if (!p) return;
    p.ready = true;
    this.broadcast({ t: 'room_update', players: this.publicPlayers() });
  }

  /**
   * 房主专用:单人不能开始;必须凑够 2 人且非房主那位已经点了准备;
   * 这局用哪档难度、哪种输入模式、哪种玩法模式都由房主这次点开始时带的值决定,
   * 不商量。submitScore 是房主"要不要上传成绩"的意愿,真正上不上还要看双方
   * 是否都登录、成绩够不够格(见 attemptCoopLeaderboardSubmit)。
   */
  handleStart(
    playerId: string, difficulty: Difficulty, inputMode: InputMode, gameMode: GameMode, submitScore: boolean,
  ): void {
    if (this.phase !== 'lobby') return;
    const host = this.players[0];
    if (!host || host.playerId !== playerId) return;
    if (this.players.length < 2) return;
    const guest = this.players[1];
    if (!guest || !guest.ready) return;
    void this.startBattle(difficulty, inputMode, gameMode, submitScore);
  }

  handleDisconnect(playerId: string): void {
    const p = this.players.find((x) => x.playerId === playerId);
    if (!p) return;
    p.connected = false;

    if (this.phase !== 'battle') {
      this.players = this.players.filter((x) => x.playerId !== playerId);
      this.broadcast({ t: 'room_update', players: this.publicPlayers() });
      if (this.players.length === 0) this.onEmpty();
      return;
    }

    // 断线 5 秒宽限,不支持断线重连(协议里没有 rejoin 消息),
    // 宽限到期就直接判该玩家出局。
    p.disconnectTimer = setTimeout(() => {
      p.eliminated = true;
      const remaining = this.players.filter((x) => !x.eliminated);
      if (remaining.length === 0) this.endBattle();
    }, 5000);
  }

  private async startBattle(
    difficulty: Difficulty, inputMode: InputMode, gameMode: GameMode, submitScore: boolean,
  ): Promise<void> {
    this.phase = 'battle';
    this.seed = nanoid(12);
    this.gameMode = gameMode;
    this.submitScoreRequested = submitScore;
    this.kills = 0;
    // 无限模式难度固定困难,排行榜才可比——不能指望客户端老实,服务端自己收敛。
    const effectiveDifficulty = gameMode === 'endless' ? ENDLESS_DIFFICULTY : difficulty;
    this.castDurationMs = DIFFICULTY_CAST_DURATION_MS[effectiveDifficulty];
    this.normalWordTimeoutMs = DIFFICULTY_WORD_TIMEOUT_MS[effectiveDifficulty];
    this.difficulty = effectiveDifficulty;
    // 地狱难度强制逐字:客户端理应也这么收敛,但输入模式决定判负规则,
    // 不能指望客户端老实,服务端自己再过一遍同一个函数。
    this.inputMode = resolveInputMode(effectiveDifficulty, inputMode);
    this.wordsSinceWrath = 0;

    const allCategories = await loadAllCategories();
    let categories = randomCategories(allCategories, this.seed);
    let banks = await loadBanks(categories);
    let pool = filterFeaturedWordPool(selectPool(banks, { categories, pureOnly: true }));

    if (pool.length === 0) {
      categories = ['starter'];
      const starter = await loadBank('starter');
      pool = filterFeaturedWordPool(selectPool([starter], { categories, pureOnly: true }));
      banks = [starter];
    }
    // 完整池留给打断词,普通词队列用按难度筛过的池
    this.interruptPool = pool;
    this.pool = filterPoolByDifficulty(pool, effectiveDifficulty);

    this.config = {
      seed: this.seed,
      bossId: 'titan',
      bossHp: bossHpFor(effectiveDifficulty),
      // 无限模式没有狂暴倒计时,这个字段联机侧目前只用于 BattleConfig 的类型完整性
      durationMs: BATTLE_DURATION_MS,
      categories,
      pureOnly: true,
      // TRADEOFF: 协议里没有商定输入模式的字段,联机固定汉字模式,不做协商。
      mode: 'hanzi',
      castIntervalMs: CAST_INTERVAL_MS,
    };
    this.bossMaxHp = bossHpFor(effectiveDifficulty);
    this.bossHp = this.bossMaxHp;
    this.teamHp = PLAYER_MAX_HP;
    this.battleStartedAt = Date.now();

    for (const p of this.players) {
      this.battleState.set(p.playerId, {
        queue: createWordQueue(this.pool, this.seed),
        currentWord: null,
        isInterrupt: false,
        combo: 0,
        damage: 0,
        wordsCompleted: 0,
        misses: 0,
        interruptsSucceeded: 0,
        interruptsFailed: 0,
        keystrokesTotal: 0,
        backspacesTotal: 0,
        attempts: [],
        targets: new Map(),
        hardFlags: new Set(),
        wordTimer: null,
        skillReadyAt: 0,
        bloodbathWordsLeft: 0,
        primalReleaseArmed: false,
      });
      this.drawNext(p.playerId);
    }

    this.broadcast({
      t: 'battle_start',
      config: this.config,
      startAt: this.battleStartedAt,
      difficulty: effectiveDifficulty,
      inputMode: this.inputMode,
      gameMode: this.gameMode,
    });
    this.tickTimer = setInterval(() => this.tick(), 250);
    // 无限模式没有狂暴倒计时,只有团队血量归零才结束,不排定这个兜底计时器。
    if (this.gameMode !== 'endless') {
      this.endTimer = setTimeout(() => this.endBattle(), BATTLE_DURATION_MS);
    }
  }

  private drawNext(playerId: string): void {
    const bs = this.battleState.get(playerId);
    if (!bs || this.ended) return;
    if (bs.wordTimer) {
      clearTimeout(bs.wordTimer);
      bs.wordTimer = null;
    }
    bs.currentWord = bs.queue.next();
    bs.isInterrupt = false;
    this.scheduleWordTimeout(playerId, bs.currentWord.id);
  }

  /** 普通词限时:超时没交卷,服务端自己判 miss,不指望客户端老实上报 */
  private scheduleWordTimeout(playerId: string, wordId: string): void {
    const bs = this.battleState.get(playerId);
    if (!bs) return;
    // 无限模式每打倒一只泰坦,限时先按 ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS 缩一截
    // (有下限),「浴血」的收紧在这个已经缩过的值上再乘一次——跟单机 SoloBattle
    // 的 wordTimeoutFor 是同一套口径。
    const base = this.gameMode === 'endless'
      ? Math.max(ENDLESS_MIN_WORD_TIMEOUT_MS, this.normalWordTimeoutMs - this.kills * ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS)
      : this.normalWordTimeoutMs;
    const timeoutMs = bs.bloodbathWordsLeft > 0
      ? Math.round(base * BLOODBATH_TIME_SCALE)
      : base;
    bs.wordTimer = setTimeout(() => {
      const cur = this.battleState.get(playerId);
      if (!cur || this.ended || cur.isInterrupt || !cur.currentWord || cur.currentWord.id !== wordId) return;
      this.resolveNormalMiss(playerId);
    }, timeoutMs);
  }

  /**
   * 普通词的失败出口。超时、地狱模式输错与反作弊硬校验失败都从这里结算：
   * 先扣血，推进到下一个普通词，再随机决定要不要插入一次泰坦之怒。
   *
   * ★ 推进与广播必须发生在 tryTriggerTitanWrath 之前:客户端消费队列的时机是
   *   固定的(见 CoopBattle.tsx),服务端只要在某条分支上跳过 drawNext,两边的
   *   队列游标就会永久错开一格,之后所有 word_attempt 都会因 wordId 对不上被
   *   本文件的 handleWordAttempt 静默丢弃。
   */
  private resolveNormalMiss(playerId: string): void {
    const bs = this.battleState.get(playerId);
    if (!bs || this.ended || bs.isInterrupt || !bs.currentWord) return;
    const failedWordId = bs.currentWord.id;
    bs.misses += 1;
    bs.combo = 0;
    // 「原初的解放」的追加效果只认「下一个词打成功」——这次没打成功,增益作废。
    bs.primalReleaseArmed = false;
    this.damageTeam(DIFFICULTY_DAMAGE_ON_MISS[this.difficulty]);
    if (this.ended) return;
    this.wordsSinceWrath += 1;
    this.drawNext(playerId);
    this.broadcast({ t: 'word_advanced', playerId, wordId: failedWordId });
    this.tryTriggerTitanWrath(TITAN_WRATH_ON_FAILURE_CHANCE);
  }

  handleWordAttempt(playerId: string, attempt: WordAttempt): void {
    const p = this.players.find((x) => x.playerId === playerId);
    const bs = this.battleState.get(playerId);
    if (!p || p.eliminated || !bs || this.phase !== 'battle' || !this.config) return;

    const nowMs = this.now();
    bs.keystrokesTotal += attempt.keystrokes.length;
    bs.backspacesTotal += attempt.backspaces;

    if (bs.isInterrupt && this.pendingMechanic) {
      this.handleMechanicAttempt(playerId, attempt, nowMs);
      return;
    }

    if (!bs.currentWord || attempt.wordId !== bs.currentWord.id) return;

    const target = targetOf(bs.currentWord, this.config.mode);
    bs.attempts.push(attempt);
    bs.targets.set(attempt.wordId, target);

    // 一致性硬校验:时间线、trusted 事件、粘贴检测。不通过就该次不算数
    // (即便文本碰巧打对了),记 0 分、扣血并留下 flag。
    const check = this.verifyAttempt(attempt, bs.currentWord.id, target, nowMs);
    if (!check.ok) {
      check.flags.forEach((f) => bs.hardFlags.add(f));
      this.resolveNormalMiss(playerId);
      return;
    }

    let prevBossHp = this.bossHp;
    if (attempt.submitted === target) {
      const raw = computeDamage(bs.currentWord.difficulty, bs.combo, false);
      // 「浴血」把奖惩一起放大
      const bloodbathDmg = bs.bloodbathWordsLeft > 0 ? Math.round(raw * BLOODBATH_MULTIPLIER) : raw;
      // 「原初的解放」的追加效果只结算这一次:团队满血就翻倍伤害,没满血就回血
      const primalArmed = bs.primalReleaseArmed;
      bs.primalReleaseArmed = false;
      const primalFullHp = primalArmed && this.teamHp >= PLAYER_MAX_HP;
      const dmg = primalFullHp ? Math.round(bloodbathDmg * PRIMAL_RELEASE_DAMAGE_MULTIPLIER) : bloodbathDmg;
      bs.damage += dmg;
      bs.combo += 1;
      bs.wordsCompleted += 1;
      prevBossHp = this.bossHp;
      this.bossHp = Math.max(0, this.bossHp - dmg);
      if (primalArmed && !primalFullHp) this.healTeam(PRIMAL_RELEASE_HEAL);
      if (this.bossHp <= 0) {
        // 标准模式到此结束;无限模式换下一只泰坦继续——新旧血量不是同一把尺子,
        // 阈值机制这次不查,直接跳到下面推进队列。
        if (!this.handleBossDefeated()) return;
        this.wordsSinceWrath += 1;
        if (bs.bloodbathWordsLeft > 0) bs.bloodbathWordsLeft -= 1;
        this.drawNext(playerId);
        if (!this.pendingMechanic) this.tryTriggerTitanWrath(TITAN_WRATH_ON_SUCCESS_CHANCE);
        return;
      }
    } else {
      // 简单/普通/困难允许原词重输；只有地狱会把一个错误字符立刻结算为失败。
      // (组合输入下客户端根本不会为「打错」发 attempt,这里只可能是地狱模式
      //  的逐字上报,或者客户端乱发 —— 两种情况都按同一套规则处理。)
      if (this.difficulty === 'hell') this.resolveNormalMiss(playerId);
      return;
    }
    // 客户端打对后一定会乐观推进到下一个词,服务端必须无条件跟上,再决定要不要
    // 插入泰坦之怒 —— 顺序反过来就会两边错位一格,理由见 resolveNormalMiss。
    this.wordsSinceWrath += 1;
    if (bs.bloodbathWordsLeft > 0) bs.bloodbathWordsLeft -= 1;
    this.drawNext(playerId);
    // 血量阈值机制优先于随机插入的泰坦之怒 —— 它是「剧情节点」
    this.tryTriggerHpMechanic(prevBossHp, this.bossHp);
    if (!this.pendingMechanic) this.tryTriggerTitanWrath(TITAN_WRATH_ON_SUCCESS_CHANCE);
  }

  /**
   * 独立型机制下,某个玩家自己已经有结果了(打过关,或放弃/超时判负)——
   * 立刻结算这一份的奖惩、放回普通词,不等队友。
   *
   * ★ 这是本条修复的核心:以前不管共享型独立型,都要等 `resolveMechanic()`
   *   在全队都有结果(或整个机制超时)之后统一结算,独立型机制手快的人打完
   *   自己那份还要干等着手慢的队友——普通词冻结、技能也开不了,体验上就像
   *   "被队友卡住了"。独立判定的本意是"各自判定",结算时机也应该各自独立。
   */
  private settleIndividualMechanic(
    playerId: string,
    pm: PendingMechanic,
    passed: boolean,
    word: WordEntry | undefined,
  ): void {
    const bs = this.battleState.get(playerId);
    if (!bs) return;
    if (passed) {
      const raw = computeDamage(word?.difficulty ?? 2, bs.combo, true);
      const dmg = bs.bloodbathWordsLeft > 0 ? Math.round(raw * BLOODBATH_MULTIPLIER) : raw;
      bs.damage += dmg;
      bs.combo += 1;
      bs.interruptsSucceeded += 1;
      this.bossHp = Math.max(0, this.bossHp - dmg);
      this.healTeam(PLAYER_HEAL_ON_INTERRUPT);
    } else {
      bs.interruptsFailed += 1;
      bs.combo = 0;
      this.damageTeam(PLAYER_DAMAGE_ON_FAIL);
    }
    pm.resolvedEarly.add(playerId);
    if (this.ended) return;
    this.resumeNormalWord(playerId);
  }

  /**
   * 机制期间的提交。判定与推进全部走 mechanics.ts 的纯函数,服务端只负责
   * 反作弊校验 + 广播 —— 加新机制不需要动这个方法。
   */
  private handleMechanicAttempt(playerId: string, attempt: WordAttempt, nowMs: number): void {
    const pm = this.pendingMechanic;
    const bs = this.battleState.get(playerId);
    if (!pm || !bs || !this.config) return;
    const state = pm.states.get(playerId);
    if (!state) return; // 已经通过的人不再判定

    const candidates = currentMechanicWords(state);
    const hit = candidates.find((w) => w.id === attempt.wordId);
    if (!hit) return; // 提交的不是当前该打的词,忽略

    const target = targetOf(hit, this.config.mode);
    bs.attempts.push(attempt);
    bs.targets.set(attempt.wordId, target);
    const check = this.verifyAttempt(attempt, hit.id, target, nowMs);
    if (!check.ok) {
      check.flags.forEach((f) => bs.hardFlags.add(f));
      return;
    }
    if (attempt.submitted !== target) return;

    const outcome = submitMechanicWord(state, hit.id);
    if (outcome.kind === 'rejected') return; // 方向/顺序不对:原地不动,不广播
    if (outcome.kind === 'progress') {
      pm.states.set(playerId, outcome.state);
      this.broadcast({ t: 'mechanic_progress', playerId, state: outcome.state });
      return;
    }

    // cleared
    pm.cleared.add(playerId);
    pm.states.delete(playerId);
    this.broadcast({ t: 'mechanic_cleared', playerId });
    if (pm.shared) {
      // 共享型:一人通过即全队通过,立刻结算
      this.resolveMechanic();
      return;
    }
    // 独立型:自己这一份立刻结算、放回普通词,不用等队友
    this.settleIndividualMechanic(playerId, pm, true, hit);
    if (this.ended) return;
    if (this.bossHp <= 0 && !this.handleBossDefeated()) return;
    if (!this.pendingMechanic) return; // 无限模式换 Boss 时顺手把机制清空了,不用再往下查
    const alive = this.players.filter((x) => !x.eliminated);
    if (pm.resolvedEarly.size >= alive.length) this.resolveMechanic();
  }

  /**
   * 玩家主动放弃当前词：服务端权威地结算为失败，不能被较低难度的重输规则绕过。
   * 打断期间客户端提交的是打断词的 id(普通词在后台原地等着),所以两种 id 都要认。
   */
  handleSkipWord(playerId: string, wordId: string): void {
    const bs = this.battleState.get(playerId);
    if (!bs || this.ended || this.phase !== 'battle') return;
    if (bs.isInterrupt) {
      // 机制期间放弃:把自己这一份从待判定里摘掉(不算通过),其余人继续。
      // 独立判定下不能因为一个人放弃就把另一个人的机制也掐了。
      const pm = this.pendingMechanic;
      if (pm && pm.states.has(playerId)) {
        pm.states.delete(playerId);
        if (pm.shared) {
          // 共享型:一人放弃不代表全队放弃;只有"所有人都没打对、也都放弃了"
          // 才判全队失败——真有人打对的话,resolveMechanic 早在那时就跑过了。
          if (pm.states.size === 0) this.resolveMechanic();
          return;
        }
        // 独立型:自己放弃就是自己没躲开,立刻结算失败、放回普通词——
        // 不连累队友,也不用等队友。
        this.settleIndividualMechanic(playerId, pm, false, undefined);
        if (this.ended) return;
        const alive = this.players.filter((x) => !x.eliminated);
        if (pm.resolvedEarly.size >= alive.length) this.resolveMechanic();
      }
      return;
    }
    if (!bs.currentWord || bs.currentWord.id !== wordId) return;
    this.resolveNormalMiss(playerId);
  }

  /** 团队血条归零直接判负结束战斗,不再有个人倒地/复活那一套 */
  private damageTeam(amount: number): void {
    if (this.ended) return;
    this.teamHp = Math.max(0, this.teamHp - amount);
    if (this.teamHp <= 0) {
      this.endBattle();
    }
  }

  private healTeam(amount: number): void {
    this.teamHp = Math.min(PLAYER_MAX_HP, this.teamHp + amount);
  }

  /**
   * 泰坦之怒:每次普通词结算后按概率插入。实际概率经 titanWrathChance 叠加保底
   * 并施加触发后的冷却窗口,地狱难度不吃那层冷却,简单难度根本不触发。
   */
  private tryTriggerTitanWrath(baseChance: number): boolean {
    const chance = titanWrathChance(baseChance, this.wordsSinceWrath, this.difficulty);
    if (Math.random() >= chance) return false;
    this.beginMechanic('titan_wrath');
    if (this.pendingMechanic) this.wordsSinceWrath = 0; // 真的触发了才重置保底
    return this.pendingMechanic !== null;
  }

  /**
   * Boss 掉血后检查血量阈值机制(三连桶 67% / 三穿一 33%)。
   *
   * ⚠ 每一条让 Boss 掉血的路径都必须调这个方法。机制成功带 2.5 倍打断加成,
   *   一击跨过整个阈值区间是常事 —— 漏一处那一档机制就被静默跳过、不报任何错。
   */
  private tryTriggerHpMechanic(prevHp: number, curHp: number): void {
    if (this.pendingMechanic || this.ended || this.bossMaxHp <= 0) return;
    const prevRatio = prevHp / this.bossMaxHp;
    const curRatio = curHp / this.bossMaxHp;
    if (this.gameMode === 'endless') {
      // 无限模式没有「打完这一只就结束」的节奏,固定阈值/机制会腻,
      // 改成四个点各自掷骰子、两个独立型机制轮着来(跟单机 SoloBattle 一致)。
      if (crossedThresholds(ENDLESS_MECHANIC_THRESHOLDS, prevRatio, curRatio).length === 0) return;
      if (Math.random() >= ENDLESS_MECHANIC_CHANCE) return;
      this.beginMechanic(this.kills % 2 === 0 ? 'three_barrels' : 'three_pierce');
      return;
    }
    const id = mechanicForHpDrop(prevRatio, curRatio, Math.random());
    if (id) this.beginMechanic(id);
  }

  /**
   * 开一次机制。所有机制走这一个入口。
   *
   * ★ 每个玩家各建一份状态 —— 三连桶要求两人独立位置、独立判定(需求 Q11)。
   *   共享型(泰坦之怒)也各发一份,但内容相同、任一人打对即全队通过。
   * ★ 机制词从**没按难度筛过的完整池**取,理由见 mechanics.ts 里的说明。
   */
  private beginMechanic(id: MechanicId): void {
    if (this.ended || this.pendingMechanic || this.phase !== 'battle') return;
    const alive = this.players.filter((p) => !p.eliminated);
    if (alive.length === 0) return;

    const shared = id === 'titan_wrath';
    const totalMs = mechanicDurationMs(id, this.difficulty);
    const states = new Map<string, MechanicState>();
    const wire: Record<string, MechanicState> = {};

    for (const p of alive) {
      // 共享型两人用同一个 seed(词必须一样);独立型带上 playerId,
      // 这样两人的方向词与出生点各不相同,不能靠抄对方的操作蒙混过关。
      const seed = shared
        ? `${this.seed}:${id}:${this.now()}`
        : `${this.seed}:${id}:${this.now()}:${p.playerId}`;
      const st = createMechanicState(id, this.interruptPool, this.difficulty, this.now(), seed, Math.random());
      if (!st) return; // 池子凑不出词就跳过这次机制,不让战斗卡住
      states.set(p.playerId, st);
      wire[p.playerId] = st;
    }

    this.pendingMechanic = {
      mechanicId: id,
      shared,
      states,
      cleared: new Set(),
      resolvedEarly: new Set(),
      bossHpAtStart: this.bossHp,
      deadline: this.now() + totalMs,
      totalMs,
    };

    for (const p of this.players) {
      const bs = this.battleState.get(p.playerId);
      if (!bs) continue;
      // 机制期间普通词不计时,免得一边打机制一边被判超时
      if (bs.wordTimer) {
        clearTimeout(bs.wordTimer);
        bs.wordTimer = null;
      }
      bs.isInterrupt = true;
    }

    this.broadcast({ t: 'mechanic_start', mechanicId: id, states: wire, durationMs: totalMs, shared });
    this.mechanicTimer = setTimeout(() => this.resolveMechanic(), totalMs);
  }

  /**
   * 机制最终清算。独立型机制下,打过关/主动放弃的人早就在
   * `settleIndividualMechanic` 里各自结算过了(见那边的注释)——这里只
   * 处理两种情况:共享型机制(一直批量结算到这一步),以及独立型里单纯
   * 超时、没打对也没主动放弃的人(按失败扣团队血)。
   */
  private resolveMechanic(): void {
    const pm = this.pendingMechanic;
    if (!pm) return;
    this.pendingMechanic = null;
    if (this.mechanicTimer) {
      clearTimeout(this.mechanicTimer);
      this.mechanicTimer = null;
    }

    const alive = this.players.filter((p) => !p.eliminated);
    const clearedBy = [...pm.cleared];

    for (const p of alive) {
      if (pm.resolvedEarly.has(p.playerId)) continue; // 独立型:已经单独结算过
      const bs = this.battleState.get(p.playerId);
      if (!bs) continue;
      if (pm.cleared.has(p.playerId) || (pm.shared && clearedBy.length > 0)) {
        // 通过:给一次打断级奖励(伤害 + 回血)。走到这里的只可能是共享型
        // (独立型的"通过"都已经在 settleIndividualMechanic 里处理过了)。
        const word = currentMechanicWords(pm.states.get(p.playerId) ?? ({} as MechanicState))[0];
        const raw = computeDamage(word?.difficulty ?? 2, bs.combo, true);
        const dmg = bs.bloodbathWordsLeft > 0 ? Math.round(raw * BLOODBATH_MULTIPLIER) : raw;
        bs.damage += dmg;
        bs.combo += 1;
        bs.interruptsSucceeded += 1;
        this.bossHp = Math.max(0, this.bossHp - dmg);
        this.healTeam(PLAYER_HEAL_ON_INTERRUPT);
      } else {
        // 没通过:共享型全队一起罚,或独立型里单纯超时(没打对也没主动放弃)的人
        bs.interruptsFailed += 1;
        bs.combo = 0;
        this.damageTeam(PLAYER_DAMAGE_ON_FAIL);
        if (this.ended) return;
      }
      this.resumeNormalWord(p.playerId);
    }

    this.broadcast({ t: 'mechanic_resolved', mechanicId: pm.mechanicId, clearedBy });

    if (this.bossHp <= 0) {
      if (!this.handleBossDefeated()) return;
      return; // 换 Boss 了,新旧血量不是同一把尺子,这次不查阈值机制
    }
    // 机制伤害同样可能跨过下一档阈值,必须再查一次——独立型的伤害大多已经在
    // settleIndividualMechanic 里实时判过了,这里用机制开始时的血量兜底,
    // 保证不会因为拆成两处结算而漏判。
    this.tryTriggerHpMechanic(pm.bossHpAtStart, this.bossHp);
  }

  /**
   * Boss 被打死。标准模式到此通关;无限模式立刻刷下一只、血量按
   * ENDLESS_BOSS_HP_GROWTH 逐只加厚,直到团队血量归零才结束——不回血,
   * 击杀奖励已经按用户要求去掉了(2026-08-06,理由同单机 SoloBattle)。
   *
   * @returns 战斗是否还要继续。false 表示已经结束,调用方应立即 return。
   */
  private handleBossDefeated(): boolean {
    if (this.gameMode !== 'endless') {
      this.endBattle(true);
      return false;
    }
    // 换 Boss 那一刻如果还有人卡在机制里(比如三连桶只有一个人打完,
    // 泰坦却被另一个人的普通词打死了),那份机制跟着旧 Boss 一起作废,
    // 把还卡着的人放回普通词——不然他们的 isInterrupt 永远卡在 true。
    if (this.pendingMechanic) {
      if (this.mechanicTimer) {
        clearTimeout(this.mechanicTimer);
        this.mechanicTimer = null;
      }
      this.pendingMechanic = null;
      for (const p of this.players) this.resumeNormalWord(p.playerId);
    }
    this.kills += 1;
    this.bossMaxHp = Math.round(this.bossMaxHp * ENDLESS_BOSS_HP_GROWTH);
    this.bossHp = this.bossMaxHp;
    return true;
  }

  /**
   * 机制结束:回到被冻结的那个普通词,重新起限时,**不消费队列**。
   * 机制是插进来的一次挑战,普通词原地冻结 —— 这条是词队列不错位的地基,
   * 客户端在 mechanic_resolved 时同样不推进队列。
   */
  private resumeNormalWord(playerId: string): void {
    const bs = this.battleState.get(playerId);
    if (!bs || this.ended) return;
    bs.isInterrupt = false;
    if (bs.currentWord) this.scheduleWordTimeout(playerId, bs.currentWord.id);
  }

  /**
   * 主动技能。服务端权威 —— 技能会跳词、改时限,交给客户端自己算等于开挂。
   */
  handleUseSkill(playerId: string): void {
    const p = this.players.find((x) => x.playerId === playerId);
    const bs = this.battleState.get(playerId);
    if (!p || !bs || this.ended || this.phase !== 'battle') return;
    if (bs.isInterrupt || !bs.currentWord) return; // 机制期间不能开
    if (this.now() < bs.skillReadyAt) return;
    bs.skillReadyAt = this.now() + SKILL_COOLDOWN_MS;

    if (p.character === 'p1') {
      // 原初的解放:换掉当前词、连击不断,不造成任何伤害。
      // 要广播 word_advanced,否则客户端的队列不会跟着走 —— 这正是词队列错位的
      // 那类 bug 的温床,技能这条新路径同样必须遵守「两边消费次数逐次相等」。
      const skipped = bs.currentWord.id;
      this.drawNext(playerId);
      // 换出来的这个新词挂上追加效果:打成功回团队血,满血则改为那个词伤害翻倍。
      bs.primalReleaseArmed = true;
      this.broadcast({ t: 'word_advanced', playerId, wordId: skipped });
    } else {
      bs.bloodbathWordsLeft = BLOODBATH_WORDS;
      // 增益期间限时收紧,重设当前词的计时器
      if (bs.currentWord) this.scheduleWordTimeout(playerId, bs.currentWord.id);
    }
    this.broadcast({ t: 'skill_used', playerId, character: p.character });
  }

  private tick(): void {
    if (this.ended) return;
    const scores: PlayerTick[] = this.players.map((p) => {
      const bs = this.battleState.get(p.playerId)!;
      const acc =
        bs.keystrokesTotal > 0
          ? Math.max(0, (bs.keystrokesTotal - bs.backspacesTotal) / bs.keystrokesTotal)
          : 1;
      const score = computeScore(bs.damage, bs.interruptsSucceeded, acc);
      return {
        playerId: p.playerId,
        score,
        damage: bs.damage,
        wordsCompleted: bs.wordsCompleted,
        misses: bs.misses,
        combo: bs.combo,
      };
    });
    this.broadcast({
      t: 'score_tick', scores, bossHp: this.bossHp, bossMaxHp: this.bossMaxHp, teamHp: this.teamHp, kills: this.kills,
    });
  }

  private endBattle(victory = false): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'ended';
    if (this.mechanicTimer) clearTimeout(this.mechanicTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    for (const bs of this.battleState.values()) {
      if (bs.wordTimer) clearTimeout(bs.wordTimer);
    }
    // 断线宽限计时器也要清:战斗已经结束,再让它 5 秒后回调没有意义,
    // 房间对象却会因此被计时器多引用 5 秒。
    for (const p of this.players) {
      if (p.disconnectTimer) {
        clearTimeout(p.disconnectTimer);
        p.disconnectTimer = null;
      }
    }

    const elapsedMs = this.now();
    const results: PlayerResult[] = this.players.map((p) => {
      const bs = this.battleState.get(p.playerId)!;
      const stats = computeStats(bs.attempts, elapsedMs, this.config?.mode ?? 'hanzi', bs.targets);
      const trust = analyzeSession(bs.attempts, elapsedMs);
      const flags = Array.from(new Set([...trust.flags, ...bs.hardFlags]));
      if (p.eliminated) flags.push('disconnected');
      return {
        playerId: p.playerId,
        nick: p.nick,
        score: computeScore(bs.damage, bs.interruptsSucceeded, stats.accuracy),
        damage: bs.damage,
        wordsCompleted: bs.wordsCompleted,
        misses: bs.misses,
        accuracy: stats.accuracy,
        cpm: stats.cpm,
        interruptsSucceeded: bs.interruptsSucceeded,
        interruptsFailed: bs.interruptsFailed,
        trustScore: trust.trustScore,
        flags,
      };
    });
    const leaderboard = this.attemptCoopLeaderboardSubmit(results, victory);
    this.broadcast({ t: 'battle_end', results, victory, kills: this.kills, leaderboard });
    this.onEmpty();
  }

  /**
   * 联机团队排行榜提交。跟单机的关键区别:这里**不需要重放校验**——
   * 联机本来就是服务端权威判定每一次 word_attempt,战斗结束时 results
   * 已经是服务端自己算出来的了,不存在"客户端报的数字要不要信"的问题。
   *
   * 资格:房主开局时勾了要传 + 双方都登录 + 难度困难/地狱
   *   (无限模式已经在 startBattle 里强制收敛成困难了)
   *   + 标准模式必须获胜(无限模式没有"通关"概念,一律可传)。
   * 双方缺一不可,不接受"一人登录就半计"——两人合作打出来的成绩,
   * 只认到一半没有意义。
   */
  private attemptCoopLeaderboardSubmit(results: PlayerResult[], victory: boolean): CoopLeaderboardOutcome | null {
    if (!this.submitScoreRequested) return null; // 房主没打算传,不打扰玩家
    if (this.players.length !== 2) return { status: 'ineligible', reason: 'need_two_players' };
    const [pa, pb] = this.players;
    if (!pa.accountId || !pb.accountId) return { status: 'ineligible', reason: 'not_both_logged_in' };
    if (!RANKED_DIFFICULTIES.includes(this.difficulty)) {
      return { status: 'ineligible', reason: 'unranked_difficulty' };
    }
    if (this.gameMode === 'standard' && !victory) {
      return { status: 'ineligible', reason: 'not_cleared' };
    }

    const ra = results.find((r) => r.playerId === pa.playerId);
    const rb = results.find((r) => r.playerId === pb.playerId);
    if (!ra || !rb) return { status: 'ineligible', reason: 'missing_result' };

    const pair = normalizePair(pa.accountId, pa.displayId ?? pa.nick, pb.accountId, pb.displayId ?? pb.nick);
    const result = submitCoopScore({
      playerAId: pair.aId,
      playerAName: pair.aName,
      playerBId: pair.bId,
      playerBName: pair.bName,
      gameMode: this.gameMode,
      difficulty: this.difficulty,
      inputMode: this.inputMode,
      clearMs: this.gameMode === 'standard' ? this.now() : undefined,
      kills: this.gameMode === 'endless' ? this.kills : undefined,
      survivedMs: this.gameMode === 'endless' ? this.now() : undefined,
      score: ra.score + rb.score,
      trustScore: Math.min(ra.trustScore, rb.trustScore),
      flags: Array.from(new Set([...ra.flags, ...rb.flags])),
    });
    return { status: result.status };
  }
}
