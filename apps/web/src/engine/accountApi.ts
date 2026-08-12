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

/**
 * 榜单按固定 7 天一段切分(2026-08-10 之前是 3 天,见服务端 scores.ts 里
 * WINDOW_TRANSITION_AT 的说明),period=0 是当前这一段,1 是上一段……
 * periodStart/periodEnd 是服务端算出来的那一段的起止时间(毫秒),前端不用
 * 自己重算——countdown 和历史标签都直接拿这两个数算,保证跟服务端一致。
 */
export interface LeaderboardResult {
  rows: LeaderboardRow[];
  period: number;
  periodStart: number;
  periodEnd: number;
  /** 是不是还能再往前翻一轮 */
  hasEarlier: boolean;
}

export async function fetchLeaderboard(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
  period = 0,
): Promise<LeaderboardResult> {
  const params = new URLSearchParams({ gameMode, difficulty, inputMode, period: String(period) });
  const res = await fetch(`/api/leaderboard?${params}`);
  if (!res.ok) return { rows: [], period, periodStart: 0, periodEnd: 0, hasEarlier: false };
  const json = await res.json() as Partial<LeaderboardResult> & { rows?: LeaderboardRow[] };
  return {
    rows: json.rows ?? [],
    period,
    periodStart: json.periodStart ?? 0,
    periodEnd: json.periodEnd ?? 0,
    hasEarlier: json.hasEarlier ?? false,
  };
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

export interface CoopLeaderboardResult {
  rows: CoopLeaderboardRow[];
  period: number;
  periodStart: number;
  periodEnd: number;
  hasEarlier: boolean;
}

export async function fetchCoopLeaderboard(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
  period = 0,
): Promise<CoopLeaderboardResult> {
  const params = new URLSearchParams({ gameMode, difficulty, inputMode, period: String(period) });
  const res = await fetch(`/api/leaderboard/coop?${params}`);
  if (!res.ok) return { rows: [], period, periodStart: 0, periodEnd: 0, hasEarlier: false };
  const json = await res.json() as Partial<CoopLeaderboardResult> & { rows?: CoopLeaderboardRow[] };
  return {
    rows: json.rows ?? [],
    period,
    periodStart: json.periodStart ?? 0,
    periodEnd: json.periodEnd ?? 0,
    hasEarlier: json.hasEarlier ?? false,
  };
}

/**
 * 「这一局排第几、打败了多少人」——结算页分享用。只读,不用登录。
 * total===0 时 beatPercent 为 null(这一轮这条赛道还没有别人的成绩可比)。
 */
export interface PercentileResult {
  rank: number;
  total: number;
  beatPercent: number | null;
}

export async function fetchPercentile(params: {
  gameMode: GameMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  clearMs?: number;
  kills?: number;
  survivedMs?: number;
}): Promise<PercentileResult | null> {
  const q = new URLSearchParams({
    gameMode: params.gameMode, difficulty: params.difficulty, inputMode: params.inputMode,
  });
  if (params.gameMode === 'endless') {
    q.set('kills', String(params.kills ?? 0));
    q.set('survivedMs', String(params.survivedMs ?? 0));
  } else {
    if (params.clearMs === undefined) return null;
    q.set('clearMs', String(params.clearMs));
  }
  const res = await fetch(`/api/leaderboard/percentile?${q}`);
  if (!res.ok) return null;
  const json = await res.json() as Partial<PercentileResult> & { ok?: boolean };
  if (json.ok === false || typeof json.rank !== 'number' || typeof json.total !== 'number') return null;
  return { rank: json.rank, total: json.total, beatPercent: json.beatPercent ?? null };
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

/**
 * 登录玩家打完一局(不管有没有点"上传成绩到排行榜"、也不管上没上榜)就存一份
 * 原始存档,7 天后服务端自动清理——排行榜(scores 表)只留每轮最好的那条,
 * 没点上传或者没打破纪录的话原始材料就彻底没地方找了,这个接口补这个口子。
 * ★ 静默失败:调用方(Results.tsx)catch 掉就行,不重试、不提示、不阻塞体验——
 *   这只是个兜底存档,不是玩家正在等待的操作。
 */
export interface LogSessionPayload extends SubmitPayload {
  victory: boolean;
  reason: string;
}

export function logSession(session: Session, payload: LogSessionPayload): Promise<{ ok: true }> {
  return post('/api/score/log-session', {
    ...payload,
    playerId: session.displayId,
    password: session.password,
  });
}

// ─────────────────────────── 联机大厅 ───────────────────────────

export interface OpenRoom {
  code: string;
  hostNick: string;
  playerCount: number;
  createdAt: number;
}

/**
 * 还在等人的公开房间。不需要登录 —— 联机本来就不强制账号。
 * 拿不到就当没有房间(返回空列表),大厅里照样能手动输房间码进。
 */
export async function fetchOpenRooms(): Promise<OpenRoom[]> {
  try {
    const res = await fetch('/api/coop/rooms');
    const json = await res.json() as { ok?: boolean; rooms?: OpenRoom[] };
    return json.ok && Array.isArray(json.rooms) ? json.rooms : [];
  } catch {
    return [];
  }
}
