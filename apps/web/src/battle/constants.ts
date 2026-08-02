export {
  BOSS_MAX_HP,
  BATTLE_DURATION_MS,
  CAST_INTERVAL_MS,
  CAST_DURATION_MS,
  CAST_WARNING_MS,
  TITAN_WRATH_ON_SUCCESS_CHANCE,
  TITAN_WRATH_ON_FAILURE_CHANCE,
  NORMAL_WORD_TIMEOUT_MULTIPLIER,
  PLAYER_MAX_HP,
  PLAYER_DAMAGE_ON_MISS,
  PLAYER_DAMAGE_ON_FAIL,
  PLAYER_HEAL_ON_INTERRUPT,
  BOSS_NAME,
  BOSS_SKILL_NAME,
  DIFFICULTY_CAST_MULTIPLIER,
} from '@eorzea/shared/battle';
import type { Difficulty } from '@eorzea/shared/battle';
export type { Difficulty };

/** 小人 attack/miss 动画回弹到 idle 的时长上限。纯前端表现参数,不随战斗协议下发 */
export const AVATAR_PULSE_MS = 380;
export const SHATTER_MS = 450;
export const FLASH_MS = 350;

/** 是否在汉字目标下方显示拼音提示。纯前端渲染选择,联机现在也会用这份表 */
export const DIFFICULTY_SHOW_READING: Record<Difficulty, boolean> = {
  easy: true,
  normal: false,
  hard: false,
  hell: false,
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '简单(带拼音提示)',
  normal: '普通',
  hard: '困难',
  hell: '地狱',
};
