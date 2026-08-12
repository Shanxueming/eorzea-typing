/**
 * 每日挑战的数据访问层。
 *
 * ★ 和正式排行榜(scores.ts)刻意分开:那边一轮 7 天、赛道按玩法+难度+输入
 *   模式切分;这边一轮 1 天、全站只有一条赛道(配置是固定的,见
 *   DAILY_CHALLENGE_CONFIG)。混在一张表里只会让两边的规则互相绊住。
 * ★ 每人每天只留最好的那条 —— 允许重打,但榜上只留你当天最快的一次。
 */
import type { CharacterId } from '@eorzea/shared/battle';
import { getDb } from './database.js';

export interface DailySubmission {
  playerId: string;
  dateKey: string;
  character: CharacterId;
  clearMs: number;
  score: number;
  accuracy: number;
  cpm: number;
  words: number;
  trustScore: number;
  flags: string[];
}

export type DailySubmitResult =
  | { status: 'inserted' }
  | { status: 'improved' }
  /** 没打破自己当天的最好成绩,榜上保留原来那条 */
  | { status: 'not_better' };

export function submitDailyScore(sub: DailySubmission): DailySubmitResult {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, clear_ms FROM daily_scores WHERE player_id = ? AND date_key = ?',
  ).get(sub.playerId, sub.dateKey) as { id: number; clear_ms: number } | undefined;

  const flags = JSON.stringify(sub.flags);
  if (!existing) {
    db.prepare(`
      INSERT INTO daily_scores (player_id, date_key, character, clear_ms, score, accuracy,
                                cpm, words, trust_score, flags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sub.playerId, sub.dateKey, sub.character, sub.clearMs, sub.score, sub.accuracy,
      sub.cpm, sub.words, sub.trustScore, flags, Date.now());
    return { status: 'inserted' };
  }

  // 标准模式口径:讨伐耗时越小越好
  if (sub.clearMs >= existing.clear_ms) return { status: 'not_better' };

  db.prepare(`
    UPDATE daily_scores SET character = ?, clear_ms = ?, score = ?, accuracy = ?, cpm = ?,
      words = ?, trust_score = ?, flags = ?, hidden = 0, created_at = ?
    WHERE id = ?
  `).run(sub.character, sub.clearMs, sub.score, sub.accuracy, sub.cpm, sub.words,
    sub.trustScore, flags, Date.now(), existing.id);
  return { status: 'improved' };
}

export interface DailyScoreRow {
  rank: number;
  displayId: string;
  character: CharacterId;
  clearMs: number;
  score: number;
  accuracy: number;
  cpm: number;
  trustScore: number;
  flags: string[];
  createdAt: number;
}

/** 某一天的榜。被封禁的玩家、被管理员下榜的成绩都不出现 */
export function getDailyLeaderboard(dateKey: string, limit = 50): DailyScoreRow[] {
  const rows = getDb().prepare(`
    SELECT d.*, p.display_id
    FROM daily_scores d JOIN players p ON p.id = d.player_id
    WHERE d.date_key = ? AND d.hidden = 0 AND p.banned = 0
    ORDER BY d.clear_ms ASC, d.created_at ASC
    LIMIT ?
  `).all(dateKey, limit) as Array<Record<string, unknown>>;

  return rows.map((r, i) => ({
    rank: i + 1,
    displayId: r.display_id as string,
    character: r.character as CharacterId,
    clearMs: r.clear_ms as number,
    score: r.score as number,
    accuracy: r.accuracy as number,
    cpm: r.cpm as number,
    trustScore: r.trust_score as number,
    flags: JSON.parse((r.flags as string) || '[]') as string[],
    createdAt: r.created_at as number,
  }));
}

/** 这个玩家当天有没有成绩、是多少 —— 菜单上显示「你今天已经打过了」用 */
export function getPlayerDailyEntry(playerId: string, dateKey: string): { clearMs: number } | null {
  const row = getDb().prepare(
    'SELECT clear_ms FROM daily_scores WHERE player_id = ? AND date_key = ? AND hidden = 0',
  ).get(playerId, dateKey) as { clear_ms: number } | undefined;
  return row ? { clearMs: row.clear_ms } : null;
}
