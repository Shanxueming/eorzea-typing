/**
 * 单机成绩的服务端重放核算。
 *
 * ★★★ 这是排行榜唯一的防线,不是「额外的一层保险」。
 *
 * 单机的整场战斗都跑在玩家自己的浏览器里,客户端报上来的分数、可信度、
 * 甚至「我打完了这些词」本身都可以随手编造。所以服务端**不信任任何结论**,
 * 只信原始材料:玩家提交的是这一局的 seed、配置和逐词击键遥测(attempts),
 * 服务端拿同一个 seed 把词序列重建出来,一条条核对:
 *
 *   1. 词对不对   —— 用同一个 seed + 同一套筛选重建队列,逐个比对 wordId
 *   2. 打的对不对 —— submitted 是否等于该词的判定文本
 *   3. 人是不是人 —— checkAttempt 逐次硬校验 + analyzeSession 整局节奏统计
 *   4. 分是不是那么多 —— 用服务端自己的 computeDamage/computeScore 重算,
 *                        和客户端声称的对不上就以服务端为准
 *
 * 客户端报上来的 score / trustScore 一概不用,只用来在日志里对照。
 */
import type { WordAttempt, WordEntry, TypingMode } from '@eorzea/shared/types';
import { computeDamage, computeScore, computeStats, targetOf } from '@eorzea/shared/scoring';
import { analyzeSession, checkAttempt } from '@eorzea/shared/anticheat';
import {
  bossHpFor,
  createWordQueue,
  filterFeaturedWordPool,
  filterPoolByDifficulty,
  type CharacterId,
  type Difficulty,
  type GameMode,
  type InputMode,
} from '@eorzea/shared/battle';
import { selectPool } from '@eorzea/shared/wordbank';
import type { WordCategory } from '@eorzea/shared/types';
import { loadBanks } from './rooms/wordbankStore.js';

/** 客户端提交上来的一整局原始材料 */
export interface ReplayPayload {
  seed: string;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  mode: TypingMode;
  categories: WordCategory[];
  pureOnly: boolean;
  attempts: WordAttempt[];
  /** 整局时长(毫秒) */
  elapsedMs: number;
  /** 客户端声称的结果,仅用于比对,不作数 */
  claimed: { score: number; kills?: number; survivedMs?: number; clearMs?: number };
}

export type ReplayVerdict =
  | {
      ok: true;
      /** 服务端重算出来的,以这份为准 */
      score: number;
      words: number;
      accuracy: number;
      cpm: number;
      trustScore: number;
      flags: string[];
      damage: number;
    }
  | { ok: false; reason: string; flags: string[] };

/** 一局最多允许多少个 attempt。防止有人塞十万条把服务端 CPU 打满 */
const MAX_ATTEMPTS = 2000;
/**
 * 客户端声称的分数最多能是服务端重算值的几倍。
 * 之所以不是 1.0:服务端还原不了技能与增益(浴血 ×1.5 等),重算值天然偏低。
 * 榜单用的是服务端的分数,这条只是拦「离谱到不可能」的谎报。
 */
const SCORE_CLAIM_RATIO = 3;
const SCORE_TOLERANCE = 500;

export async function replayAndScore(payload: ReplayPayload): Promise<ReplayVerdict> {
  const { attempts } = payload;
  if (attempts.length === 0) return { ok: false, reason: 'no_attempts', flags: [] };
  if (attempts.length > MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts', flags: [] };
  if (payload.elapsedMs <= 0) return { ok: false, reason: 'bad_elapsed', flags: [] };

  // ── 1. 用同一个 seed + 同一套筛选重建词池与队列 ──
  // 这一步必须和 SoloBattle 走完全相同的流水线,否则重建出来的词序和玩家实际
  // 打的对不上,好人也会被判成作弊。
  const banks = await loadBanks(payload.categories);
  // 完整池:机制词(泰坦之怒/三连桶/三穿一)就是从这里取的,**没有过难度筛选**
  const fullPool = filterFeaturedWordPool(selectPool(banks, {
    categories: payload.categories,
    pureOnly: payload.pureOnly,
  }));
  // 普通词池:按难度筛过,战斗里的词队列走的是这个
  const pool = filterPoolByDifficulty(fullPool, payload.difficulty);
  if (pool.length === 0) return { ok: false, reason: 'empty_pool', flags: [] };
  // 机制词的合法来源。它们不在普通词序列里,但也不是凭空捏造的
  const mechanicWordIds = new Set(fullPool.map((w) => w.id));

  const queue = createWordQueue(pool, payload.seed);
  const hardFlags = new Set<string>();
  const targets = new Map<string, string>();

  let damage = 0;
  let combo = 0;
  let words = 0;
  /** 机制成功次数。战斗场景只在机制通关时才记 attempt,所以数它就等于打断成功数 */
  let interrupts = 0;
  let bossHp = bossHpFor(payload.difficulty);
  let kills = 0;

  /**
   * 逐条核对。
   *
   * ★ 这里刻意**不模拟机制与技能**:它们会打乱队列消费的节奏(技能跳词、
   *   机制插入),服务端没有那些事件的记录也就无法精确复现。所以判定放宽成
   *   「提交的词必须出自这个 seed 生成的序列、且顺序单调向前」——
   *   跳过几个词是允许的(技能/超时/机制都会造成跳词),但**凭空造词不允许**,
   *   因为造出来的 wordId 根本不在序列里。
   */
  const window: WordEntry[] = [];
  const WINDOW_AHEAD = 400; // 往前看这么多词,足够覆盖跳词
  for (let i = 0; i < WINDOW_AHEAD; i++) window.push(queue.next());
  let cursor = 0;

  for (const attempt of attempts) {
    // 在剩余窗口里往前找这个词。找不到 = 这个词不在本局序列里
    let found = -1;
    for (let i = cursor; i < window.length; i++) {
      if (window[i].id === attempt.wordId) { found = i; break; }
    }
    if (found === -1) {
      // ★ 不在普通词序列里,再看看是不是机制词。
      //   机制词从完整池取(短词优先),困难/地狱的普通词池掐掉了短词,所以它们
      //   本来就不会出现在队列里 —— 这不是作弊,是设计如此。
      //   只有两个池子都查不到的 wordId 才是真的凭空捏造。
      if (mechanicWordIds.has(attempt.wordId)) {
        // 机制词不参与词序推进,也不计伤害(伤害无法从 attempts 可靠还原),
        // 但仍然要过一遍硬校验 —— 作弊者一样可以往机制词上做手脚。
        const mech = fullPool.find((w) => w.id === attempt.wordId);
        if (mech) {
          const mechTarget = targetOf(mech, payload.mode);
          targets.set(mech.id, mechTarget);
          const mechCheck = checkAttempt(
            attempt, { wordId: mech.id, target: mechTarget }, attempt.submittedAt,
          );
          if (!mechCheck.ok) mechCheck.flags.forEach((f) => hardFlags.add(f));
          // 机制通关按打断计:伤害带 INTERRUPT_BONUS,并计入打断成功数。
          // 不算的话服务端重算的分数会系统性低于客户端,好人全被判成虚报。
          if (attempt.submitted === mechTarget) {
            damage += computeDamage(mech.difficulty, combo, true);
            combo += 1;
            interrupts += 1;
          }
        }
        continue;
      }
      return { ok: false, reason: 'word_not_in_sequence', flags: ['word_id_mismatch'] };
    }
    const word = window[found];
    cursor = found + 1;
    // 窗口用掉一段就补一段,保证后面还有 WINDOW_AHEAD 个词可看
    while (window.length - cursor < WINDOW_AHEAD) window.push(queue.next());

    const target = targetOf(word, payload.mode);
    targets.set(word.id, target);

    // 硬校验:合成事件、时间线倒流、粘贴。
    // 单机没有服务端墙钟做基准,用 attempt 自己的 submittedAt —— 于是
    // clock_skew 这条在单机天然不成立,真正起作用的是其余三条。
    const check = checkAttempt(attempt, { wordId: word.id, target }, attempt.submittedAt);
    if (!check.ok) check.flags.forEach((f) => hardFlags.add(f));

    if (attempt.submitted === target) {
      const dmg = computeDamage(word.difficulty, combo, false);
      damage += dmg;
      combo += 1;
      words += 1;
      bossHp -= dmg;
      if (bossHp <= 0) {
        kills += 1;
        bossHp = bossHpFor(payload.difficulty);
      }
    } else {
      combo = 0;
    }
  }

  // ── 2. 整局节奏统计 ──
  const stats = computeStats(attempts, payload.elapsedMs, payload.mode, targets);
  const trust = analyzeSession(attempts, payload.elapsedMs);
  const flags = Array.from(new Set([...trust.flags, ...hardFlags]));

  // ── 3. 服务端自己重算得分 ──
  const score = computeScore(damage, interrupts, stats.accuracy);

  /**
   * ★ 入库的**永远是上面这个服务端分数**,客户端报多少都不影响榜单 ——
   *   这才是防作弊真正起作用的地方。
   *
   * 下面这条比对只用来抓「客户端明显在撒谎」,所以容差放得很宽:
   * 服务端无法还原技能与增益(「浴血」让伤害 ×1.5、机制失败清连击等),
   * 重算值系统性地略低于客户端是正常的。卡太紧只会把正常玩家全判成作弊,
   * 而卡松也不会放过谁 —— 想刷分得伪造 attempts,那要同时骗过词序核对和
   * checkAttempt 的击键校验。
   */
  if (payload.claimed.score > score * SCORE_CLAIM_RATIO + SCORE_TOLERANCE) {
    hardFlags.add('score_overclaim');
    return {
      ok: false,
      reason: 'score_overclaim',
      flags: Array.from(new Set([...flags, 'score_overclaim'])),
    };
  }

  return {
    ok: true,
    score,
    words,
    accuracy: stats.accuracy,
    cpm: stats.cpm,
    trustScore: trust.trustScore,
    flags,
    damage,
  };
}
