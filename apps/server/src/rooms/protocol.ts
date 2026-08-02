/**
 * 联机协议。基础字段名照抄 CODEX_PLAN.md §5。
 *
 * ★ 这次按用户的要求改了房主流程和血条机制,协议做了几处不在原文档里的新增:
 *   1. C2S 加了 'start'(房主专用,携带这局用哪档难度)
 *   2. PlayerPublic 加了 isHost,前端要知道谁是房主才能决定显示哪套控件
 *   3. score_tick 顶层加了 teamHp —— 联机两人共用一条血条,不是每人各一条,
 *      所以血量挂在 score_tick 顶层而不是 PlayerTick 里
 *   4. battle_start 顶层加了 difficulty(不是塞进 BattleConfig 里,
 *      BattleConfig 是 packages/shared/src/types.ts 里的只读类型,
 *      加一层不动它)
 *   5. 去掉了 player_down —— 团队血条归零直接判负结束战斗,不再有个人倒地
 *      + 5 秒复活这一套(那是改血条机制之前的设计)
 *   6. 加了 boss_cast_warning:读条正式开始前 1 秒的预警,让玩家有个心理
 *      准备,这个阶段还不能打断,真正能打的是随后的 boss_cast
 *   7. PlayerTick 加了 combo —— 双方都要能看到自己(以及对手)当前连击数,
 *      放在各自小人左右两侧
 */
import type { WebSocket } from 'ws';
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
  /** 服务端主动判定普通词失败后,通知对应客户端消费词队列的下一项。 */
  | { t: 'word_advanced'; playerId: string; wordId: string }
  | { t: 'score_tick'; scores: PlayerTick[]; bossHp: number; teamHp: number }
  | { t: 'battle_end'; results: PlayerResult[]; victory: boolean }
  | { t: 'error'; msg: string };

export interface ConnectedPlayer {
  playerId: string;
  nick: string;
  ws: WebSocket;
  ready: boolean;
  connected: boolean;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  eliminated: boolean;
}

export function send(ws: WebSocket, msg: S2C): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
