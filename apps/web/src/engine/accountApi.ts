/**
 * 账号与排行榜的前端 API 封装。
 *
 * ★ 登录态存 localStorage,里面**只有 ID 和玩家密码** —— 提交成绩时要重新
 *   带着它们验证一次身份(服务端不认「前端说自己是谁」)。root 密码从不存,
 *   它是玩家自己保管的线下凭证。
 */
import type { CharacterId, Difficulty, GameMode, InputMode } from '@eorzea/shared/battle';
import type { WordAttempt, WordCategory, TypingMode } from '@eorzea/shared/types';

export interface IssuedAccount {
  displayId: string;
  password: string;
  rootPassword: string;
}

export interface Session {
  displayId: string;
  password: string;
}

const SESSION_KEY = 'eorzea:session';

export function loadSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return typeof s?.displayId === 'string' && typeof s?.password === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // 无痕模式写不进去 —— 这一局还是能玩,只是下次要重新登录
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch { /* 同上 */ }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json() as T & { ok?: boolean; error?: string };
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export function register(): Promise<IssuedAccount & { ok: true }> {
  return post('/api/account/register', {});
}

export function login(id: string, password: string): Promise<{ ok: true; displayId: string }> {
  return post('/api/account/login', { id, password });
}

// ─────────────────────────── 排行榜 ───────────────────────────

export interface LeaderboardRow {
  rank: number;
  displayId: string;
  character: CharacterId;
  clearMs: number | null;
  kills: number | null;
  survivedMs: number | null;
  score: number;
  accuracy: number;
  cpm: number;
  trustScore: number;
  flags: string[];
}

export async function fetchLeaderboard(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
): Promise<LeaderboardRow[]> {
  const params = new URLSearchParams({ gameMode, difficulty, inputMode });
  const res = await fetch(`/api/leaderboard?${params}`);
  if (!res.ok) return [];
  const json = await res.json() as { rows?: LeaderboardRow[] };
  return json.rows ?? [];
}

/** 联机团队榜的一条记录——两个人绑在一起,不是单人榜那种一人一条 */
export interface CoopLeaderboardRow {
  rank: number;
  playerAName: string;
  playerBName: string;
  clearMs: number | null;
  kills: number | null;
  survivedMs: number | null;
  score: number;
  trustScore: number;
  flags: string[];
}

export async function fetchCoopLeaderboard(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
): Promise<CoopLeaderboardRow[]> {
  const params = new URLSearchParams({ gameMode, difficulty, inputMode });
  const res = await fetch(`/api/leaderboard/coop?${params}`);
  if (!res.ok) return [];
  const json = await res.json() as { rows?: CoopLeaderboardRow[] };
  return json.rows ?? [];
}

/**
 * 提交成绩。
 *
 * ★ 交上去的是**原始材料**(seed + 配置 + 逐词遥测),不是分数。
 *   服务端会用同一个 seed 重建词序列、逐条核对、重跑反作弊、重算得分 ——
 *   客户端算出来的分只作为「有没有虚报」的比对项。
 */
export interface SubmitPayload {
  seed: string;
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  mode: TypingMode;
  categories: WordCategory[];
  pureOnly: boolean;
  attempts: WordAttempt[];
  elapsedMs: number;
  claimed: { score: number; kills?: number; survivedMs?: number; clearMs?: number };
}

export interface SubmitResult {
  ok: true;
  status: 'inserted' | 'improved' | 'not_better';
  trustScore: number;
  flags: string[];
}

export function submitScore(session: Session, payload: SubmitPayload): Promise<SubmitResult> {
  return post('/api/score/submit', {
    ...payload,
    playerId: session.displayId,
    password: session.password,
  });
}
