/**
 * 排行榜的数据访问层。
 *
 * ★ 赛道 = 玩法 + 难度 + 输入模式。三者任一不同就不是同一条榜 ——
 *   组合输入允许反复退格,准确率天然低于逐字,混在一起比没有意义。
 * ★ 每人每条赛道只留一条(最好的那条)。写入时用「比现有的好才替换」的逻辑,
 *   而不是留一堆再查询时取最大 —— 库更小,查询也不用去重。
 */
import type { CharacterId, Difficulty, GameMode, InputMode } from '@eorzea/shared/battle';
import { getDb } from './database.js';

/** 只有这三档收录成绩。简单/普通不进榜(需求 Q22) */
export const RANKED_DIFFICULTIES: readonly Difficulty[] = ['hard', 'hell'];

/**
 * 榜单只看最近 3 天的成绩(用户明确要的滚动窗口)——旧成绩不删,只是查询时
 * 过滤掉,不在榜上显示。所有榜单(单机 + 联机)统一套用这一条,口径要一致。
 */
export const LEADERBOARD_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

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
  const existing = db.prepare(`
    SELECT id, clear_ms, kills, survived_ms FROM scores
    WHERE player_id = ? AND game_mode = ? AND difficulty = ? AND input_mode = ?
  `).get(sub.playerId, sub.gameMode, sub.difficulty, sub.inputMode) as
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
): ScoreRow[] {
  const rows = getDb().prepare(`
    SELECT s.*, p.display_id
    FROM scores s JOIN players p ON p.id = s.player_id
    WHERE s.game_mode = ? AND s.difficulty = ? AND s.input_mode = ?
      AND s.hidden = 0 AND p.banned = 0 AND s.created_at >= ?
    ORDER BY ${orderClause(gameMode)}
    LIMIT ?
  `).all(gameMode, difficulty, inputMode, Date.now() - LEADERBOARD_WINDOW_MS, limit) as Array<Record<string, unknown>>;

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
