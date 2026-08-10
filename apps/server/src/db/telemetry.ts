/**
 * 用量埋点:管理后台"数据监控"看板背后的数据访问层。
 *
 * ★ 这里只是"今天有多少人玩过、开了多少把"的粗统计,不是反作弊或计费系统——
 *   device_id 纯粹是客户端随机生成、存在 localStorage 里的匿名串,伪造/清空
 *   localStorage 都能让计数失真,精度只到"大致够用"。
 */
import type { Difficulty, GameMode, InputMode } from '@eorzea/shared/battle';
import { getDb } from './database.js';

export interface GameStartEvent {
  deviceId: string;
  mode: 'solo' | 'coop';
  gameMode: string;
  difficulty: string;
  /** 联机才有:房间码,用来把同一局两个人报的两条事件去重成"一局" */
  matchKey?: string;
  /** ★ 2026-08-08 补充:赛道 = 玩法+难度+输入模式,少这个百分位统计按赛道就不准 */
  inputMode?: string;
}

export function recordGameStart(ev: GameStartEvent): void {
  getDb().prepare(`
    INSERT INTO game_starts (device_id, mode, game_mode, difficulty, match_key, input_mode, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ev.deviceId, ev.mode, ev.gameMode, ev.difficulty, ev.matchKey ?? null, ev.inputMode ?? null, Date.now());
}

/**
 * 这条赛道(单机)在这个时间窗口内,大致有多少台设备开过局——粗略估算,
 * 不是精确人数(见文件头注释:匿名、可伪造、按设备而非账号去重)。
 *
 * ★ 只给百分位统计当"未上榜人数"的估算用,不用于任何排名/反作弊判定——
 *   那些必须走 scores 表里经过服务端重放核算的数据,这里的口径不够硬。
 */
export function getSoloAttemptEstimate(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
  start: number,
  end: number,
): number {
  const row = getDb().prepare(`
    SELECT COUNT(DISTINCT device_id) AS n FROM game_starts
    WHERE mode = 'solo' AND game_mode = ? AND difficulty = ? AND input_mode = ?
      AND created_at >= ? AND created_at < ?
  `).get(gameMode, difficulty, inputMode, start, end) as { n: number };
  return row.n;
}

export interface DailyStatsRow {
  /** 本地时区(服务器是 CST)的日期,如 "2026-08-07" */
  day: string;
  /** 当天去重后的设备数 */
  dau: number;
  soloGames: number;
  coopGames: number;
  totalGames: number;
}

/** 最近 days 天,倒序(今天在最前面) */
export function getDailyStats(days = 30): DailyStatsRow[] {
  const rows = getDb().prepare(`
    SELECT
      date(created_at / 1000, 'unixepoch', 'localtime') AS day,
      COUNT(DISTINCT device_id) AS dau,
      SUM(CASE WHEN mode = 'solo' THEN 1 ELSE 0 END) AS solo_games,
      COUNT(DISTINCT CASE WHEN mode = 'coop' THEN match_key END) AS coop_games
    FROM game_starts
    GROUP BY day
    ORDER BY day DESC
    LIMIT ?
  `).all(days) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const solo = Number(r.solo_games ?? 0);
    const coop = Number(r.coop_games ?? 0);
    return {
      day: r.day as string,
      dau: Number(r.dau ?? 0),
      soloGames: solo,
      coopGames: coop,
      totalGames: solo + coop,
    };
  });
}
