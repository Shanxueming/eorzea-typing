/**
 * 联机团队排行榜的数据访问层。
 *
 * ★ 跟单机 scores.ts 的关键区别:这里一条记录代表"一对搭档"而不是一个人,
 *   而且不需要客户端重放核算——联机本来就是服务端权威判定每一次
 *   word_attempt,战斗结束时服务器已经算好双方的分数了,不存在"客户端报的
 *   数字要不要信"的问题(见 Room.attemptCoopLeaderboardSubmit)。
 */
import type { Difficulty, GameMode, InputMode } from '@eorzea/shared/battle';
import { getDb } from './database.js';
import { leaderboardPeriod } from './scores.js';

export interface CoopScoreSubmission {
  playerAId: string;
  playerAName: string;
  playerBId: string;
  playerBName: string;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  clearMs?: number;
  kills?: number;
  survivedMs?: number;
  score: number;
  trustScore: number;
  flags: string[];
}

export interface CoopScoreRow {
  rank: number;
  playerAId: string;
  playerAName: string;
  playerBId: string;
  playerBName: string;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  clearMs: number | null;
  kills: number | null;
  survivedMs: number | null;
  score: number;
  trustScore: number;
  flags: string[];
  createdAt: number;
}

function orderClause(gameMode: GameMode): string {
  return gameMode === 'endless'
    ? 'kills DESC, survived_ms DESC, created_at ASC'
    : 'clear_ms ASC, created_at ASC';
}

function isBetter(next: CoopScoreSubmission, prev: {
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

/** 把两个玩家 id 按字典序排好——不管谁创房、谁是"A",同一对人永远映射到同一条记录 */
export function normalizePair(
  idA: string, nameA: string, idB: string, nameB: string,
): { aId: string; aName: string; bId: string; bName: string } {
  return idA <= idB
    ? { aId: idA, aName: nameA, bId: idB, bName: nameB }
    : { aId: idB, aName: nameB, bId: idA, bName: nameA };
}

export type CoopSubmitResult =
  | { status: 'inserted' }
  | { status: 'improved' }
  | { status: 'not_better' };

export function submitCoopScore(sub: CoopScoreSubmission): CoopSubmitResult {
  const db = getDb();
  // ★ 同 scores.ts 的修复:「existing」必须限定在当前这一轮内查找,不能跨轮次
  //   全局比较,否则这一轮的新成绩会被几轮之前的旧纪录挡住,永远进不了这一轮的榜。
  const { start, end } = leaderboardPeriod(0);
  const existing = db.prepare(`
    SELECT id, clear_ms, kills, survived_ms FROM coop_scores
    WHERE player_a_id = ? AND player_b_id = ? AND game_mode = ? AND difficulty = ? AND input_mode = ?
      AND created_at >= ? AND created_at < ?
  `).get(sub.playerAId, sub.playerBId, sub.gameMode, sub.difficulty, sub.inputMode, start, end) as
    { id: number; clear_ms: number | null; kills: number | null; survived_ms: number | null } | undefined;

  const flags = JSON.stringify(sub.flags);
  if (!existing) {
    db.prepare(`
      INSERT INTO coop_scores (player_a_id, player_a_name, player_b_id, player_b_name,
                                game_mode, difficulty, input_mode, clear_ms, kills, survived_ms,
                                score, trust_score, flags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sub.playerAId, sub.playerAName, sub.playerBId, sub.playerBName,
      sub.gameMode, sub.difficulty, sub.inputMode, sub.clearMs ?? null, sub.kills ?? null, sub.survivedMs ?? null,
      sub.score, sub.trustScore, flags, Date.now());
    return { status: 'inserted' };
  }

  if (!isBetter(sub, existing)) return { status: 'not_better' };

  db.prepare(`
    UPDATE coop_scores SET player_a_name = ?, player_b_name = ?, clear_ms = ?, kills = ?, survived_ms = ?,
      score = ?, trust_score = ?, flags = ?, hidden = 0, created_at = ?
    WHERE id = ?
  `).run(sub.playerAName, sub.playerBName, sub.clearMs ?? null, sub.kills ?? null, sub.survivedMs ?? null,
    sub.score, sub.trustScore, flags, Date.now(), existing.id);
  return { status: 'improved' };
}

function rowToCoopScore(r: Record<string, unknown>, rank: number): CoopScoreRow {
  return {
    rank,
    playerAId: r.player_a_id as string,
    playerAName: r.player_a_name as string,
    playerBId: r.player_b_id as string,
    playerBName: r.player_b_name as string,
    gameMode: r.game_mode as GameMode,
    difficulty: r.difficulty as Difficulty,
    inputMode: r.input_mode as InputMode,
    clearMs: r.clear_ms as number | null,
    kills: r.kills as number | null,
    survivedMs: r.survived_ms as number | null,
    score: r.score as number,
    trustScore: r.trust_score as number,
    flags: JSON.parse((r.flags as string) || '[]') as string[],
    createdAt: r.created_at as number,
  };
}

export function getCoopLeaderboard(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
  limit = 50,
  periodOffset = 0,
): CoopScoreRow[] {
  const { start, end } = leaderboardPeriod(periodOffset);
  // 两个搭档只要有一个被封禁,这条团队记录就不该再出现在榜上
  const rows = getDb().prepare(`
    SELECT cs.* FROM coop_scores cs
    JOIN players pa ON pa.id = cs.player_a_id
    JOIN players pb ON pb.id = cs.player_b_id
    WHERE cs.game_mode = ? AND cs.difficulty = ? AND cs.input_mode = ?
      AND cs.hidden = 0 AND pa.banned = 0 AND pb.banned = 0 AND cs.created_at >= ? AND cs.created_at < ?
    ORDER BY ${orderClause(gameMode)}
    LIMIT ?
  `).all(gameMode, difficulty, inputMode, start, end, limit) as Array<Record<string, unknown>>;

  return rows.map((r, i) => rowToCoopScore(r, i + 1));
}

/** 管理员下榜/恢复 */
export function setCoopScoreHidden(scoreId: number, hidden: boolean): boolean {
  const info = getDb().prepare('UPDATE coop_scores SET hidden = ? WHERE id = ?')
    .run(hidden ? 1 : 0, scoreId);
  return info.changes > 0;
}

/** 管理员视角:能看到被隐藏的记录 */
export function listCoopScoresForAdmin(limit = 100): Array<CoopScoreRow & { id: number; hidden: boolean }> {
  const rows = getDb().prepare(`
    SELECT * FROM coop_scores ORDER BY created_at DESC LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map((r, i) => ({
    ...rowToCoopScore(r, i + 1),
    id: r.id as number,
    hidden: !!(r.hidden as number),
  }));
}
