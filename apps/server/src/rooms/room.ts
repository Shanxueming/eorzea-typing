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
  createWordQueue,
  filterFeaturedWordPool,
  pickShortInterruptWord,
  type WordQueue,
  type Difficulty,
  BOSS_MAX_HP,
  BATTLE_DURATION_MS,
  CAST_INTERVAL_MS,
  CAST_DURATION_MS,
  DIFFICULTY_CAST_MULTIPLIER,
  NORMAL_WORD_TIMEOUT_MULTIPLIER,
  PLAYER_MAX_HP,
  PLAYER_DAMAGE_ON_MISS,
  PLAYER_DAMAGE_ON_FAIL,
  PLAYER_HEAL_ON_INTERRUPT,
  BOSS_SKILL_NAME,
  TITAN_WRATH_ON_FAILURE_CHANCE,
  TITAN_WRATH_ON_SUCCESS_CHANCE,
} from '@eorzea/shared/battle';
import { loadAllCategories, loadBank, loadBanks } from './wordbankStore.js';
import { send, type ConnectedPlayer, type PlayerPublic, type PlayerTick, type S2C } from './protocol.js';
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
  /** 普通词限时计时器,打断期间不跑这个,由 triggerCast 清掉 */
  wordTimer: ReturnType<typeof setTimeout> | null;
}

interface PendingCast {
  castId: string;
  word: WordEntry;
  deadline: number;
  resolvedBy: string | null;
}

export class Room {
  readonly code: string;
  players: ConnectedPlayer[] = [];
  phase: 'lobby' | 'battle' | 'ended' = 'lobby';

  private onEmpty: () => void;
  private battleStartedAt = 0;
  private seed = '';
  private pool: WordEntry[] = [];
  private config: BattleConfig | null = null;
  private bossHp = 0;
  private teamHp = 0;
  private castDurationMs = CAST_DURATION_MS;
  private normalWordTimeoutMs = CAST_DURATION_MS * NORMAL_WORD_TIMEOUT_MULTIPLIER;
  private difficulty: Difficulty = 'normal';
  private battleState = new Map<string, PlayerBattleState>();
  private pendingCast: PendingCast | null = null;
  private castTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
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

  publicPlayers(): PlayerPublic[] {
    // 第一个加入的玩家就是房主,不用额外存字段
    return this.players.map((p, i) => ({ playerId: p.playerId, nick: p.nick, ready: p.ready, isHost: i === 0 }));
  }

  broadcast(msg: S2C): void {
    for (const p of this.players) send(p.ws, msg);
  }

  addPlayer(nick: string, ws: WebSocket): ConnectedPlayer {
    if (this.players.length >= 2 || this.phase !== 'lobby') {
      throw new Error('room_full');
    }
    const player: ConnectedPlayer = {
      playerId: nanoid(8),
      nick,
      ws,
      ready: false,
      connected: true,
      disconnectTimer: null,
      eliminated: false,
    };
    this.players.push(player);
    return player;
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
   * 这局用哪档难度由房主这次点开始时带的值决定,不商量。
   */
  handleStart(playerId: string, difficulty: Difficulty): void {
    if (this.phase !== 'lobby') return;
    const host = this.players[0];
    if (!host || host.playerId !== playerId) return;
    if (this.players.length < 2) return;
    const guest = this.players[1];
    if (!guest || !guest.ready) return;
    void this.startBattle(difficulty);
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

  private async startBattle(difficulty: Difficulty): Promise<void> {
    this.phase = 'battle';
    this.seed = nanoid(12);
    this.castDurationMs = Math.round(CAST_DURATION_MS * DIFFICULTY_CAST_MULTIPLIER[difficulty]);
    this.normalWordTimeoutMs = Math.round(this.castDurationMs * NORMAL_WORD_TIMEOUT_MULTIPLIER);
    this.difficulty = difficulty;

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
    this.pool = pool;

    this.config = {
      seed: this.seed,
      bossId: 'titan',
      bossHp: BOSS_MAX_HP,
      durationMs: BATTLE_DURATION_MS,
      categories,
      pureOnly: true,
      // TRADEOFF: 协议里没有商定输入模式的字段,联机固定汉字模式,不做协商。
      mode: 'hanzi',
      castIntervalMs: CAST_INTERVAL_MS,
    };
    this.bossHp = BOSS_MAX_HP;
    this.teamHp = PLAYER_MAX_HP;
    this.battleStartedAt = Date.now();

    for (const p of this.players) {
      this.battleState.set(p.playerId, {
        queue: createWordQueue(pool, this.seed),
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
      });
      this.drawNext(p.playerId);
    }

    this.broadcast({ t: 'battle_start', config: this.config, startAt: this.battleStartedAt, difficulty });
    this.tickTimer = setInterval(() => this.tick(), 250);
    this.endTimer = setTimeout(() => this.endBattle(), BATTLE_DURATION_MS);
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
    bs.wordTimer = setTimeout(() => {
      const cur = this.battleState.get(playerId);
      if (!cur || this.ended || cur.isInterrupt || !cur.currentWord || cur.currentWord.id !== wordId) return;
      this.resolveNormalMiss(playerId);
    }, this.normalWordTimeoutMs);
  }

  /**
   * 普通词的失败出口。超时、地狱模式输错与反作弊硬校验失败都从这里结算：
   * 先扣血，再随机决定推进到下一词或立刻进入泰坦之怒。
   */
  private resolveNormalMiss(playerId: string): void {
    const bs = this.battleState.get(playerId);
    if (!bs || this.ended || bs.isInterrupt || !bs.currentWord) return;
    const failedWordId = bs.currentWord.id;
    bs.misses += 1;
    bs.combo = 0;
    this.damageTeam(PLAYER_DAMAGE_ON_MISS);
    if (this.ended) return;
    if (this.tryTriggerTitanWrath(TITAN_WRATH_ON_FAILURE_CHANCE)) return;
    this.drawNext(playerId);
    this.broadcast({ t: 'word_advanced', playerId, wordId: failedWordId });
  }

  handleWordAttempt(playerId: string, attempt: WordAttempt): void {
    const p = this.players.find((x) => x.playerId === playerId);
    const bs = this.battleState.get(playerId);
    if (!p || p.eliminated || !bs || this.phase !== 'battle' || !this.config) return;

    const nowMs = this.now();
    bs.keystrokesTotal += attempt.keystrokes.length;
    bs.backspacesTotal += attempt.backspaces;

    if (bs.isInterrupt && this.pendingCast && this.pendingCast.resolvedBy === null) {
      const target = targetOf(this.pendingCast.word, this.config.mode);
      bs.attempts.push(attempt);
      bs.targets.set(attempt.wordId, target);
      const check = checkAttempt(attempt, { wordId: this.pendingCast.word.id, target }, nowMs);
      if (!check.ok) {
        check.flags.forEach((f) => bs.hardFlags.add(f));
        if (this.difficulty === 'hell') this.resolveCastTimeout(this.pendingCast.castId);
      } else if (attempt.wordId === this.pendingCast.word.id && attempt.submitted === target) {
        this.resolveCastSuccess(playerId);
      } else if (this.difficulty === 'hell') {
        this.resolveCastTimeout(this.pendingCast.castId);
      }
      return;
    }

    if (!bs.currentWord || attempt.wordId !== bs.currentWord.id) return;

    const target = targetOf(bs.currentWord, this.config.mode);
    bs.attempts.push(attempt);
    bs.targets.set(attempt.wordId, target);

    // 一致性硬校验:时间线、trusted 事件、粘贴检测。不通过就该次不算数
    // (即便文本碰巧打对了),记 0 分、扣血并留下 flag。
    const check = checkAttempt(attempt, { wordId: bs.currentWord.id, target }, nowMs);
    if (!check.ok) {
      check.flags.forEach((f) => bs.hardFlags.add(f));
      this.resolveNormalMiss(playerId);
      return;
    }

    if (attempt.submitted === target) {
      const dmg = computeDamage(bs.currentWord.difficulty, bs.combo, false);
      bs.damage += dmg;
      bs.combo += 1;
      bs.wordsCompleted += 1;
      this.bossHp = Math.max(0, this.bossHp - dmg);
      if (this.bossHp <= 0) {
        this.endBattle(true);
        return;
      }
    } else {
      // 简单/普通/困难允许原词重输；只有地狱会把一个错误字符立刻结算为失败。
      if (this.difficulty === 'hell') this.resolveNormalMiss(playerId);
      return;
    }
    if (!this.tryTriggerTitanWrath(TITAN_WRATH_ON_SUCCESS_CHANCE)) this.drawNext(playerId);
  }

  /** 玩家主动放弃当前词：服务端权威地结算为失败，不能被较低难度的重输规则绕过。 */
  handleSkipWord(playerId: string, wordId: string): void {
    const bs = this.battleState.get(playerId);
    if (!bs || this.ended || this.phase !== 'battle' || !bs.currentWord || bs.currentWord.id !== wordId) return;
    if (bs.isInterrupt && this.pendingCast) {
      this.resolveCastTimeout(this.pendingCast.castId);
      return;
    }
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

  /** 泰坦之怒只跟着普通词失败随机触发,不再按计时器抢断玩家正在输入的词。 */
  private tryTriggerTitanWrath(chance: number): boolean {
    if (Math.random() >= chance) return false;
    this.triggerCast();
    return this.pendingCast !== null;
  }

  private triggerCast(): void {
    if (this.ended || this.pendingCast || this.phase !== 'battle') return;
    const word = pickShortInterruptWord(this.pool, `${this.seed}:cast:${Date.now()}`);
    if (!word) return;

    const castId = nanoid(8);
    this.pendingCast = { castId, word, deadline: this.now() + this.castDurationMs, resolvedBy: null };
    for (const p of this.players) {
      const bs = this.battleState.get(p.playerId);
      if (bs) {
        if (bs.wordTimer) {
          clearTimeout(bs.wordTimer);
          bs.wordTimer = null;
        }
        bs.isInterrupt = true;
        bs.currentWord = word;
      }
    }
    this.broadcast({ t: 'boss_cast', castId, skillName: BOSS_SKILL_NAME, word, castMs: this.castDurationMs });
    this.castTimeoutTimer = setTimeout(() => this.resolveCastTimeout(castId), this.castDurationMs);
  }

  private resolveCastSuccess(playerId: string): void {
    if (!this.pendingCast || this.pendingCast.resolvedBy) return;
    const { castId, word } = this.pendingCast;
    this.pendingCast.resolvedBy = playerId;
    if (this.castTimeoutTimer) clearTimeout(this.castTimeoutTimer);

    const bs = this.battleState.get(playerId)!;
    const dmg = computeDamage(word.difficulty, bs.combo, true);
    bs.damage += dmg;
    bs.combo += 1;
    bs.interruptsSucceeded += 1;
    this.bossHp = Math.max(0, this.bossHp - dmg);
    this.healTeam(PLAYER_HEAL_ON_INTERRUPT);

    this.broadcast({ t: 'cast_resolved', castId, interruptedBy: playerId });
    for (const p of this.players) {
      const b = this.battleState.get(p.playerId);
      if (b) {
        b.isInterrupt = false;
        this.drawNext(p.playerId);
      }
    }
    this.pendingCast = null;

    if (this.bossHp <= 0) this.endBattle(true);
  }

  private resolveCastTimeout(castId: string): void {
    if (!this.pendingCast || this.pendingCast.castId !== castId || this.pendingCast.resolvedBy) return;
    this.broadcast({ t: 'cast_resolved', castId, interruptedBy: null });
    this.damageTeam(PLAYER_DAMAGE_ON_FAIL);

    for (const p of this.players) {
      const bs = this.battleState.get(p.playerId);
      if (!bs) continue;
      bs.isInterrupt = false;
      bs.interruptsFailed += 1;
      bs.combo = 0;
      this.drawNext(p.playerId);
    }
    this.pendingCast = null;
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
    this.broadcast({ t: 'score_tick', scores, bossHp: this.bossHp, teamHp: this.teamHp });
  }

  private endBattle(victory = false): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'ended';
    if (this.castTimeoutTimer) clearTimeout(this.castTimeoutTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    for (const bs of this.battleState.values()) {
      if (bs.wordTimer) clearTimeout(bs.wordTimer);
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
    this.broadcast({ t: 'battle_end', results, victory });
    this.onEmpty();
  }
}
