/**
 * 排行榜的数据访问层。
 *
 * ★ 赛道 = 玩法 + 难度 + 输入模式。三者任一不同就不是同一条榜 ——
 *   组合输入允许反复退格,准确率天然低于逐字,混在一起比没有意义。
 * ★ 每人每条赛道**每一轮(period)**只留一条(这一轮里最好的那条)。写入时用
 *   「比现有的好才替换」的逻辑,而不是留一堆再查询时取最大 —— 库更小,查询
 *   也不用去重。★ 这个"现有"必须限定在当前轮次内查找,不能跨轮次比较——
 *   否则新一轮的成绩会被几轮之前的旧纪录挡住,见 submitScore 里的注释。
 */
import type { CharacterId, Difficulty, GameMode, InputMode } from '@eorzea/shared/battle';
import { getDb } from './database.js';
import { getSoloAttemptEstimate } from './telemetry.js';

/** 只有这三档收录成绩。简单/普通不进榜(需求 Q22) */
export const RANKED_DIFFICULTIES: readonly Difficulty[] = ['hard', 'hell'];

/**
 * 榜单按固定长度切分(从 Unix epoch 对齐,不是"从现在往回数"的滚动窗口)——
 * 旧成绩不删,只是查询时按所在的那一段过滤。这样每一段都有确定的起止时间,
 * 能有"下一轮几点几分整轮刷新"这个说法,也能回看之前几轮。所有榜单(单机 +
 * 联机)统一套用这一条,口径要一致。
 *
 * ★ 2026-08-10:段长从 3 天改成 7 天,但**不能动当前正在进行的那一轮**——
 *   直接改常量会让 leaderboardPeriod 用新的段长重新对齐整条时间轴,连带把
 *   "现在算第几轮"也算错,当前这一轮的起止时间会跟着挪位置。所以老规则
 *   （3 天网格）只管到 WINDOW_TRANSITION_AT 这个时刻为止——这个值就是改动
 *   当下"当前这一轮"原本该结束的时刻,硬编码成字面量,不能用运行时公式
 *   重新推导(重新推导的话每次部署/重启都会算出不同的值,起不到"锚点"的
 *   作用)。到了这个时刻之后,新一轮开始用 7 天网格,往后每一轮都以这个
 *   时刻为起点顺延。
 * ★ 3 天、7 天都是 24 小时的整数倍,所以每一段的边界换算成北京时间永远落在
 *   固定的 08:00,不会随着"现在几点"到处漂——这是刻意的,不是巧合。
 */
export const LEADERBOARD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 切换前用的旧段长,只用来推算切换点之前的历史轮次边界 */
const OLD_LEADERBOARD_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** 2026-08-11 08:00 北京时间——切换前"当前这一轮"原本的结束时刻,见上面的说明 */
const WINDOW_TRANSITION_AT = 1786406400000;

function oldPeriodStart(index: number): number {
  return index * OLD_LEADERBOARD_WINDOW_MS;
}

/**
 * offset=0 是当前这一段,1 是上一段,以此类推。
 *
 * ★ 分段函数:WINDOW_TRANSITION_AT 之前完全沿用旧的 3 天网格(不管 now 是
 *   在切换前调用、还是切换后回看切换前的历史轮次,这段时间轴上的边界永远
 *   按旧网格算,结果不会变);到达/超过这个时刻之后,新一轮固定按 7 天网格
 *   从这个锚点顺延。offset 往回翻,翻出新网格覆盖的范围就自动接上旧网格继续
 *   往回数——这段过渡期(切换后头三轮,约 21 天)历史轮次的边界是新旧两种
 *   网格拼起来的,之后 offset 能覆盖的范围就完全落在新网格里了。
 */
export function leaderboardPeriod(offset = 0): { start: number; end: number } {
  const now = Date.now();
  if (now >= WINDOW_TRANSITION_AT) {
    const elapsedNewPeriods = Math.floor((now - WINDOW_TRANSITION_AT) / LEADERBOARD_WINDOW_MS);
    const targetIndex = elapsedNewPeriods - offset;
    if (targetIndex >= 0) {
      const start = WINDOW_TRANSITION_AT + targetIndex * LEADERBOARD_WINDOW_MS;
      return { start, end: start + LEADERBOARD_WINDOW_MS };
    }
    // offset 翻过了锚点,退回旧网格继续往回数——从锚点之前最后一个旧网格
    // 边界起算,targetIndex 是负数,-targetIndex 就是还要往回翻几轮旧网格
    const lastOldIndex = Math.floor((WINDOW_TRANSITION_AT - 1) / OLD_LEADERBOARD_WINDOW_MS);
    const start = oldPeriodStart(lastOldIndex - (-targetIndex - 1));
    return { start, end: start + OLD_LEADERBOARD_WINDOW_MS };
  }
  // 还没到切换点:完全沿用旧的 3 天网格,当前这一轮不受任何影响
  const index = Math.floor(now / OLD_LEADERBOARD_WINDOW_MS) - offset;
  const start = oldPeriodStart(index);
  return { start, end: start + OLD_LEADERBOARD_WINDOW_MS };
}

/** 最多能往回翻几轮历史榜单(0 = 当前这一轮,不含) */
export const MAX_LEADERBOARD_PERIODS_BACK = 3;

/** 请求里的 period 参数不可信:夹到 [0, MAX_LEADERBOARD_PERIODS_BACK] 之间 */
export function clampPeriod(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_LEADERBOARD_PERIODS_BACK);
}

export interface ScoreSubmission {
  playerId: string;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  /** 标准模式:讨伐耗时(毫秒)。无限模式为 undefined */
  clearMs?: number;
  kills?: number;
  survivedMs?: number;
  score: number;
  accuracy: number;
  cpm: number;
  words: number;
  trustScore: number;
  flags: string[];
}

export interface ScoreRow {
  rank: number;
  playerId: string;
  displayId: string;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  clearMs: number | null;
  kills: number | null;
  survivedMs: number | null;
  score: number;
  accuracy: number;
  cpm: number;
  words: number;
  trustScore: number;
  flags: string[];
  createdAt: number;
}

/**
 * 这条赛道的排序规则。
 * - 标准模式:比**讨伐耗时**,越快越好(需求 Q21)
 * - 无限模式:比击杀数,同数再比存活时长
 */
function orderClause(gameMode: GameMode): string {
  return gameMode === 'endless'
    ? 'kills DESC, survived_ms DESC, created_at ASC'
    : 'clear_ms ASC, created_at ASC';
}

/** 新成绩是不是比旧的好。规则必须和 orderClause 完全一致,否则会出现「上不了榜但其实更好」 */
function isBetter(next: ScoreSubmission, prev: {
  clear_ms: number | null; kills: number | null; survived_ms: number | null;
}): boolean {
  if (next.gameMode === 'endless') {
    const nk = next.kills ?? 0;
    const pk = prev.kills ?? 0;
    if (nk !== pk) return nk > pk;
    return (next.survivedMs ?? 0) > (prev.survived_ms ?? 0);
  }
  const nc = next.clearMs ?? Number.POSITIVE_INFINITY;
  const pc = prev.clear_ms ?? Number.POSITIVE_INFINITY;
  return nc < pc;
}

export type SubmitResult =
  | { status: 'inserted' }
  | { status: 'improved' }
  /** 没超过自己已有的成绩,不替换 */
  | { status: 'not_better' };

export function submitScore(sub: ScoreSubmission): SubmitResult {
  const db = getDb();
  // ★ 2026-08-08 修复:「existing」必须限定在当前这一轮(period)内查找,不能
  //   跨轮次全局比较——榜单本来就是按轮各自独立的(getLeaderboard /
  //   getScorePercentile 都按 period 过滤),但这里以前没有 created_at 的过滤
  //   条件,导致"每人每条赛道只留一条"实际上是"只留全站历史最好的那一条"。
  //   难度调整之后新纪录天然比旧纪录差,或者单纯运气差,都会让这一轮打出的
  //   本轮最好成绩因为拼不过几轮之前的旧纪录而被判 not_better,永远进不了
  //   这一轮的榜、也不会被本轮的 percentile 统计到。
  const { start, end } = leaderboardPeriod(0);
  const existing = db.prepare(`
    SELECT id, clear_ms, kills, survived_ms FROM scores
    WHERE player_id = ? AND game_mode = ? AND difficulty = ? AND input_mode = ?
      AND created_at >= ? AND created_at < ?
  `).get(sub.playerId, sub.gameMode, sub.difficulty, sub.inputMode, start, end) as
    { id: number; clear_ms: number | null; kills: number | null; survived_ms: number | null } | undefined;

  const flags = JSON.stringify(sub.flags);
  if (!existing) {
    db.prepare(`
      INSERT INTO scores (player_id, game_mode, difficulty, input_mode, character,
                          clear_ms, kills, survived_ms, score, accuracy, cpm, words,
                          trust_score, flags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sub.playerId, sub.gameMode, sub.difficulty, sub.inputMode, sub.character,
      sub.clearMs ?? null, sub.kills ?? null, sub.survivedMs ?? null,
      sub.score, sub.accuracy, sub.cpm, sub.words, sub.trustScore, flags, Date.now());
    return { status: 'inserted' };
  }

  if (!isBetter(sub, existing)) return { status: 'not_better' };

  db.prepare(`
    UPDATE scores SET character = ?, clear_ms = ?, kills = ?, survived_ms = ?,
      score = ?, accuracy = ?, cpm = ?, words = ?, trust_score = ?, flags = ?,
      hidden = 0, created_at = ?
    WHERE id = ?
  `).run(sub.character, sub.clearMs ?? null, sub.kills ?? null, sub.survivedMs ?? null,
    sub.score, sub.accuracy, sub.cpm, sub.words, sub.trustScore, flags, Date.now(), existing.id);
  return { status: 'improved' };
}

export function getLeaderboard(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
  limit = 50,
  periodOffset = 0,
): ScoreRow[] {
  const { start, end } = leaderboardPeriod(periodOffset);
  const rows = getDb().prepare(`
    SELECT s.*, p.display_id
    FROM scores s JOIN players p ON p.id = s.player_id
    WHERE s.game_mode = ? AND s.difficulty = ? AND s.input_mode = ?
      AND s.hidden = 0 AND p.banned = 0 AND s.created_at >= ? AND s.created_at < ?
    ORDER BY ${orderClause(gameMode)}
    LIMIT ?
  `).all(gameMode, difficulty, inputMode, start, end, limit) as Array<Record<string, unknown>>;

  return rows.map((r, i) => ({
    rank: i + 1,
    playerId: r.player_id as string,
    displayId: r.display_id as string,
    gameMode: r.game_mode as GameMode,
    difficulty: r.difficulty as Difficulty,
    inputMode: r.input_mode as InputMode,
    character: r.character as CharacterId,
    clearMs: r.clear_ms as number | null,
    kills: r.kills as number | null,
    survivedMs: r.survived_ms as number | null,
    score: r.score as number,
    accuracy: r.accuracy as number,
    cpm: r.cpm as number,
    words: r.words as number,
    trustScore: r.trust_score as number,
    flags: JSON.parse((r.flags as string) || '[]') as string[],
    createdAt: r.created_at as number,
  }));
}

export interface PercentileResult {
  /** 名次(比这局强的人数 + 1)。total===0 时恒为 1 */
  rank: number;
  /** 这条赛道、这一轮里参与比较的总人数 */
  total: number;
  /** 打败了百分之多少人,0~100 取整;total===0(没人可比)时为 null */
  beatPercent: number | null;
}

/**
 * 算这一局在「当前这条赛道 + 这一轮」里排第几、打败了多少人。
 *
 * ★ 只查 RANKED_DIFFICULTIES 的赛道才有意义——scores 表压根不收简单/普通的
 *   成绩(见 api.ts 的 unranked_difficulty 校验),调用方要自己先过滤难度。
 * ★ 比较口径必须和 orderClause / isBetter 完全一致:标准模式比 clear_ms
 *   (越小越强),无限模式比 kills 再比 survived_ms(越大越强)。不能偷懒改用
 *   通用的 score 字段——那不是榜单实际排序用的指标,算出来的名次会跟真榜对不上。
 * ★ 沿用榜单同一套「按轮」窗口(leaderboardPeriod),不然玩家会看到
 *   「打败了 90% 的人」但翻开榜单一个熟悉的名字都没有——那些人早就不在这一轮了。
 * ★ 2026-08-08:分母不能只数 scores 表——那张表只收「点了上传、服务端重放
 *   核算也通过」的成绩,标准模式没通关根本没资格调那个接口,分母因此系统性
 *   偏小、"超越了多少人"虚高。这里额外拿开局埋点(game_starts,按设备去重的
 *   粗略估算)补上没能留下 scores 行的那部分人,一律当作"比你差"——没有验证
 *   过的成绩没资格说自己比你强。这个估算不影响 rank/榜单本身,只影响这个
 *   百分比的分母,所以不需要 scores 那套服务端重放的可信度。
 */
export function getScorePercentile(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
  metric: { clearMs?: number; kills?: number; survivedMs?: number },
  periodOffset = 0,
): PercentileResult {
  const { start, end } = leaderboardPeriod(periodOffset);
  const db = getDb();
  const base = `
    FROM scores s JOIN players p ON p.id = s.player_id
    WHERE s.game_mode = ? AND s.difficulty = ? AND s.input_mode = ?
      AND s.hidden = 0 AND p.banned = 0 AND s.created_at >= ? AND s.created_at < ?
  `;
  const baseArgs = [gameMode, difficulty, inputMode, start, end];

  const scoredTotal = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...baseArgs) as { n: number }).n;
  // 开局埋点估算的"这条赛道大致有多少人打过";没能留下 scores 行的那部分人
  // (未通关 / 没点上传 / 没通过重放核算)全部按"比你差"补进分母。
  const attemptEstimate = getSoloAttemptEstimate(gameMode, difficulty, inputMode, start, end);
  const unscored = Math.max(0, attemptEstimate - scoredTotal);
  const total = scoredTotal + unscored;
  if (total === 0) return { rank: 1, total: 0, beatPercent: null };

  let betterClause: string;
  let betterArgs: number[];
  let worseClause: string;
  let worseArgs: number[];
  if (gameMode === 'endless') {
    const kills = metric.kills ?? 0;
    const survivedMs = metric.survivedMs ?? 0;
    betterClause = 'AND (s.kills > ? OR (s.kills = ? AND s.survived_ms > ?))';
    betterArgs = [kills, kills, survivedMs];
    worseClause = 'AND (s.kills < ? OR (s.kills = ? AND s.survived_ms < ?))';
    worseArgs = [kills, kills, survivedMs];
  } else {
    const clearMs = metric.clearMs ?? Number.POSITIVE_INFINITY;
    betterClause = 'AND s.clear_ms < ?';
    betterArgs = [clearMs];
    worseClause = 'AND s.clear_ms > ?';
    worseArgs = [clearMs];
  }

  const better = (db.prepare(`SELECT COUNT(*) AS n ${base} ${betterClause}`)
    .get(...baseArgs, ...betterArgs) as { n: number }).n;
  const worseScored = (db.prepare(`SELECT COUNT(*) AS n ${base} ${worseClause}`)
    .get(...baseArgs, ...worseArgs) as { n: number }).n;
  // 没留下 scores 行的那部分人,没有任何验证过的成绩可比,一律算作"比你差"
  const worse = worseScored + unscored;

  const rank = better + 1;
  // ★ total 是库里已有的行数(加上估算的未上榜人数),不含「这一局」本身——
  //   每人每条赛道只留一条最好成绩(见文件头注释),同一个人打了一局却没打破
  //   自己的纪录时,这一局根本没有对应的行。这时如果只回原始 total,会出现
  //   「第 2 名 / 共 1 人」这种名次比总数还大的怪现象。
  //   把这一局也算作占了一个位置,保证 rank 永远不超过 total。
  return { rank, total: Math.max(total, rank), beatPercent: Math.round((worse / total) * 100) };
}

/** 管理员下榜/恢复。不删记录,只翻 hidden 标记 —— 误操作可以还原 */
export function setScoreHidden(scoreId: number, hidden: boolean): boolean {
  const info = getDb().prepare('UPDATE scores SET hidden = ? WHERE id = ?')
    .run(hidden ? 1 : 0, scoreId);
  return info.changes > 0;
}

/** 管理员视角:能看到被隐藏的记录,并带上 scores.id 方便操作 */
export function listScoresForAdmin(limit = 100): Array<ScoreRow & { id: number; hidden: boolean }> {
  const rows = getDb().prepare(`
    SELECT s.*, p.display_id FROM scores s JOIN players p ON p.id = s.player_id
    ORDER BY s.created_at DESC LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map((r, i) => ({
    id: r.id as number,
    hidden: !!(r.hidden as number),
    rank: i + 1,
    playerId: r.player_id as string,
    displayId: r.display_id as string,
    gameMode: r.game_mode as GameMode,
    difficulty: r.difficulty as Difficulty,
    inputMode: r.input_mode as InputMode,
    character: r.character as CharacterId,
    clearMs: r.clear_ms as number | null,
    kills: r.kills as number | null,
    survivedMs: r.survived_ms as number | null,
    score: r.score as number,
    accuracy: r.accuracy as number,
    cpm: r.cpm as number,
    words: r.words as number,
    trustScore: r.trust_score as number,
    flags: JSON.parse((r.flags as string) || '[]') as string[],
    createdAt: r.created_at as number,
  }));
}
