/**
 * 联机协议类型,与 apps/server/src/rooms/protocol.ts 保持字段一致。
 * 前后端各自维护一份类型声明,避免 apps/web 依赖 apps/server 的构建产物。
 *
 * 房主流程 + 共享血条机制新增了 'start' / isHost / score_tick.teamHp /
 * battle_start.difficulty,去掉了 player_down;详细理由见
 * apps/server/src/rooms/protocol.ts 顶部注释。
 */
import type { BattleConfig, PlayerResult, WordAttempt, WordEntry } from '@eorzea/shared/types';
import type { Difficulty } from '@eorzea/shared/battle';

export type C2S =
  | { t: 'create_room'; nick: string }
  | { t: 'join_room'; code: string; nick: string }
  | { t: 'ready' }
  | { t: 'start'; difficulty: Difficulty }
  | { t: 'word_attempt'; attempt: WordAttempt }
  | { t: 'skip_word'; wordId: string }
  | { t: 'heartbeat'; clientTime: number };

export interface PlayerPublic {
  playerId: string;
  nick: string;
  ready: boolean;
  isHost: boolean;
}

export interface PlayerTick {
  playerId: string;
  score: number;
  damage: number;
  wordsCompleted: number;
  misses: number;
  combo: number;
}

export type S2C =
  | { t: 'room_joined'; code: string; playerId: string; players: PlayerPublic[] }
  | { t: 'room_update'; players: PlayerPublic[] }
  | { t: 'battle_start'; config: BattleConfig; startAt: number; difficulty: Difficulty }
  | { t: 'boss_cast_warning'; skillName: string }
  | { t: 'boss_cast'; castId: string; skillName: string; word: WordEntry; castMs: number }
  | { t: 'cast_resolved'; castId: string; interruptedBy: string | null }
  | { t: 'word_advanced'; playerId: string; wordId: string }
  | { t: 'score_tick'; scores: PlayerTick[]; bossHp: number; teamHp: number }
  | { t: 'battle_end'; results: PlayerResult[]; victory: boolean }
  | { t: 'error'; msg: string };

export function coopSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
