/**
 * 登录玩家的原始对局存档——不是排行榜数据源,纯粹是"万一榜单出问题/玩家
 * 想找回来"的兜底,7 天自动清理。完整背景见 database.ts 里 play_sessions
 * 表的注释。
 */
import type { CharacterId, Difficulty, GameMode, InputMode } from '@eorzea/shared/battle';
import type { WordAttempt, WordCategory, TypingMode } from '@eorzea/shared/types';
import { getDb } from './database.js';

/** 存档保留时长。到期的由 cleanupOldPlaySessions 清掉 */
export const PLAY_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 单局最多允许多少个 attempt——和 scoreReplay.ts 的 MAX_ATTEMPTS 同一个数,防止塞爆存储 */
const MAX_ATTEMPTS = 2000;

export interface PlaySessionInput {
  playerId: string;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  mode: TypingMode;
  categories: WordCategory[];
  pureOnly: boolean;
  seed: string;
  elapsedMs: number;
  victory: boolean;
  reason: string;
  attempts: WordAttempt[];
  claimed: { score: number; kills?: number; survivedMs?: number; clearMs?: number };
}

export type RecordPlaySessionResult =
  | { ok: true }
  | { ok: false; reason: 'too_many_attempts' };

/** 存一局的原始材料。不跑重放核算、不做防作弊判定——这里只是存档,不是榜单入口 */
export function recordPlaySession(input: PlaySessionInput): RecordPlaySessionResult {
  if (input.attempts.length > MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  getDb().prepare(`
    INSERT INTO play_sessions (
      player_id, game_mode, difficulty, input_mode, character, mode, categories, pure_only,
      seed, elapsed_ms, victory, reason,
      claimed_score, claimed_clear_ms, claimed_kills, claimed_survived_ms,
      attempts, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.playerId, input.gameMode, input.difficulty, input.inputMode, input.character, input.mode,
    JSON.stringify(input.categories), input.pureOnly ? 1 : 0,
    input.seed, input.elapsedMs, input.victory ? 1 : 0, input.reason,
    input.claimed.score, input.claimed.clearMs ?? null, input.claimed.kills ?? null,
    input.claimed.survivedMs ?? null,
    JSON.stringify(input.attempts), Date.now(),
  );
  return { ok: true };
}

/** 清掉过期存档。启动时跑一次,之后定时跑——见 app.ts 里的调度 */
export function cleanupOldPlaySessions(): number {
  const cutoff = Date.now() - PLAY_SESSION_RETENTION_MS;
  const info = getDb().prepare('DELETE FROM play_sessions WHERE created_at < ?').run(cutoff);
  return Number(info.changes);
}

export interface PlaySessionSummary {
  id: number;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  mode: TypingMode;
  categories: WordCategory[];
  pureOnly: boolean;
  seed: string;
  elapsedMs: number;
  victory: boolean;
  reason: string;
  claimedScore: number;
  claimedClearMs: number | null;
  claimedKills: number | null;
  claimedSurvivedMs: number | null;
  attemptCount: number;
  createdAt: number;
}

/**
 * 排查/找回用:某个玩家最近的对局存档,不带 attempts 明细(那份数据大,
 * 真要重放核算再单独用 getPlaySessionAttempts 按 id 取)。
 */
export function listRecentSessionsForPlayer(playerId: string, limit = 20): PlaySessionSummary[] {
  const rows = getDb().prepare(`
    SELECT id, game_mode, difficulty, input_mode, character, mode, categories, pure_only,
           seed, elapsed_ms, victory, reason,
           claimed_score, claimed_clear_ms, claimed_kills, claimed_survived_ms,
           attempts, created_at
    FROM play_sessions WHERE player_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(playerId, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as number,
    gameMode: r.game_mode as GameMode,
    difficulty: r.difficulty as Difficulty,
    inputMode: r.input_mode as InputMode,
    character: r.character as CharacterId,
    mode: r.mode as TypingMode,
    categories: JSON.parse(r.categories as string) as WordCategory[],
    pureOnly: !!(r.pure_only as number),
    seed: r.seed as string,
    elapsedMs: r.elapsed_ms as number,
    victory: !!(r.victory as number),
    reason: r.reason as string,
    claimedScore: r.claimed_score as number,
    claimedClearMs: r.claimed_clear_ms as number | null,
    claimedKills: r.claimed_kills as number | null,
    claimedSurvivedMs: r.claimed_survived_ms as number | null,
    attemptCount: (JSON.parse(r.attempts as string) as unknown[]).length,
    createdAt: r.created_at as number,
  }));
}

/** 按 id 取某一局的完整原始 attempts——要重放核算/人工找回时用 */
export function getPlaySessionAttempts(id: number): WordAttempt[] | null {
  const row = getDb().prepare('SELECT attempts FROM play_sessions WHERE id = ?').get(id) as
    { attempts: string } | undefined;
  return row ? (JSON.parse(row.attempts) as WordAttempt[]) : null;
}
