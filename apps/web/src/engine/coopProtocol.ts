/**
 * 联机协议类型,与 apps/server/src/rooms/protocol.ts 保持字段一致。
 * 前后端各自维护一份类型声明,避免 apps/web 依赖 apps/server 的构建产物。
 * ★ 改协议必须两个文件一起改。
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
 *   6. PlayerTick 加了 combo —— 双方都要能看到自己(以及对手)当前连击数,
 *      放在各自小人左右两侧
 *   7. start / battle_start 加了 inputMode(逐字 or 组合)。它决定「打错算不算
 *      失败」,两个人必须同一套规则,所以和难度一样由房主定、服务端权威下发。
 *      地狱难度会被服务端强制收敛成逐字(见 resolveInputMode)。
 *   8. ★ boss_cast / cast_resolved / boss_cast_warning 全部由 mechanic_* 取代。
 *      Boss 机制现在有三种(泰坦之怒 / 三连桶 / 三穿一),再给每种配一套消息会
 *      失控,所以统一成「开始 / 有人推进了 / 结算」三条,机制的差异全部装在
 *      MechanicState 里(定义在 packages/shared/src/mechanics.ts)。加新机制
 *      **不需要再动协议**。
 *   9. 角色技能与选人:C2S 的 'use_skill' / 'select_character',S2C 的
 *      'skill_used'。技能会改变战斗结果(跳词、改时限),必须服务端权威。
 */
import type { BattleConfig, PlayerResult, WordAttempt, WordEntry } from '@eorzea/shared/types';
import type { CharacterId, Difficulty, InputMode } from '@eorzea/shared/battle';
import type { MechanicId, MechanicState } from '@eorzea/shared/mechanics';

export type C2S =
  | { t: 'create_room'; nick: string }
  | { t: 'join_room'; code: string; nick: string }
  | { t: 'ready' }
  /** 大厅里选角色。两人可以选同一个 —— 这是合作不是对战,没必要抢 */
  | { t: 'select_character'; character: CharacterId }
  /** 房主开局:难度与输入模式都由房主定,不商量(输入模式影响判负规则,必须统一) */
  | { t: 'start'; difficulty: Difficulty; inputMode: InputMode }
  | { t: 'word_attempt'; attempt: WordAttempt }
  | { t: 'skip_word'; wordId: string }
  | { t: 'use_skill' }
  | { t: 'heartbeat'; clientTime: number };

export interface PlayerPublic {
  playerId: string;
  nick: string;
  ready: boolean;
  isHost: boolean;
  character: CharacterId;
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
  | { t: 'battle_start'; config: BattleConfig; startAt: number; difficulty: Difficulty; inputMode: InputMode }
  /**
   * 机制开始。`states` 是**每个玩家各自的**初始状态 —— 三连桶要求两人有独立
   * 位置和独立判定,所以状态按 playerId 分开下发;泰坦之怒这种全房共享的机制,
   * 两人的状态内容相同但仍各发一份,客户端不必区分。
   */
  | {
      t: 'mechanic_start';
      mechanicId: MechanicId;
      states: Record<string, MechanicState>;
      durationMs: number;
      /** 全房共享型(任一人打对即全队通过)还是各自独立判定 */
      shared: boolean;
    }
  /** 某个玩家推进了一步(三连桶挪了一格 / 三穿一打对了一个) */
  | { t: 'mechanic_progress'; playerId: string; state: MechanicState }
  /** 某个玩家已经完成了这次机制,等其他人或等超时 */
  | { t: 'mechanic_cleared'; playerId: string }
  /** 机制结束。clearedBy 是成功躲过的人,其余的人各自吃了一份伤害 */
  | { t: 'mechanic_resolved'; mechanicId: MechanicId; clearedBy: string[] }
  | { t: 'skill_used'; playerId: string; character: CharacterId }
  /** 服务端主动判定普通词失败后,通知对应客户端消费词队列的下一项。 */
  | { t: 'word_advanced'; playerId: string; wordId: string }
  | { t: 'score_tick'; scores: PlayerTick[]; bossHp: number; bossMaxHp: number; teamHp: number }
  | { t: 'battle_end'; results: PlayerResult[]; victory: boolean }
  | { t: 'error'; msg: string };

export function coopSocketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
