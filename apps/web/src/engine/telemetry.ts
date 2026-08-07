import type { Difficulty, GameMode } from '@eorzea/shared/battle';
import { deviceId } from './deviceId';

/**
 * 开一局就报一次,纯粹给管理后台的用量看板用——失败了就算了,不重试、
 * 不提示、不阻塞任何游戏流程。联机传 matchKey(房间码),后端靠它把
 * 两个人各报的一条去重成"一局";单机不传,每条都是独立一局。
 */
export function pingGameStart(
  mode: 'solo' | 'coop',
  gameMode: GameMode,
  difficulty: Difficulty,
  matchKey?: string,
): void {
  try {
    void fetch('/api/telemetry/game-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: deviceId(), mode, gameMode, difficulty, matchKey }),
      keepalive: true,
    }).catch(() => { /* 统计失败不影响游戏 */ });
  } catch {
    /* 同上 */
  }
}
