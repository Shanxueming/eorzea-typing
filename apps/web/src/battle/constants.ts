export {
  BOSS_MAX_HP,
  BATTLE_DURATION_MS,
  CAST_INTERVAL_MS,
  CAST_DURATION_MS,
  CAST_WARNING_MS,
  TITAN_WRATH_ON_SUCCESS_CHANCE,
  TITAN_WRATH_ON_FAILURE_CHANCE,
  PLAYER_MAX_HP,
  PLAYER_DAMAGE_ON_FAIL,
  PLAYER_HEAL_ON_INTERRUPT,
  BOSS_NAME,
  BOSS_SKILL_NAME,
  DIFFICULTY_WORD_TIMEOUT_MS,
  DIFFICULTY_CAST_DURATION_MS,
  DIFFICULTY_DAMAGE_ON_MISS,
  DIFFICULTY_WORD_LENGTH,
  filterPoolByDifficulty,
  hasTitanWrath,
  TITAN_WRATH_PITY_STEP,
  TITAN_WRATH_PITY_CAP,
  TITAN_WRATH_COOLDOWN_WORDS,
  titanWrathChance,
  DEFAULT_INPUT_MODE,
  allowsComposedInput,
  resolveInputMode,
  ENDLESS_DIFFICULTY,
  ENDLESS_BOSS_HP_GROWTH,
  ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS,
  ENDLESS_MIN_WORD_TIMEOUT_MS,
  SKILL_COOLDOWN_MS,
  SKILLS,
  CHARACTER_LABEL,
  BLOODBATH_WORDS,
  BLOODBATH_MULTIPLIER,
  BLOODBATH_TIME_SCALE,
  PRIMAL_RELEASE_HEAL,
  PRIMAL_RELEASE_DAMAGE_MULTIPLIER,
} from '@eorzea/shared/battle';
import type { Difficulty } from '@eorzea/shared/battle';
export type { Difficulty };
export type { InputMode, CharacterId, GameMode } from '@eorzea/shared/battle';

/** 只有这两档会计入排行榜。和服务端 db/scores.ts 的 RANKED_DIFFICULTIES 必须一致 */
export const RANKED_DIFFICULTIES: readonly Difficulty[] = ['hard', 'hell'];

/** 小人 attack/miss 动画回弹到 idle 的时长上限。纯前端表现参数,不随战斗协议下发 */
export const AVATAR_PULSE_MS = 380;
export const SHATTER_MS = 450;
export const FLASH_MS = 350;

/** 是否在汉字目标下方显示拼音提示。纯前端渲染选择,联机现在也会用这份表 */
export const DIFFICULTY_SHOW_READING: Record<Difficulty, boolean> = {
  practice: true,
  easy: true,
  normal: false,
  hard: false,
  hell: false,
};

/**
 * 汉字模式下,普通/困难难度按 Q 键能临时揭示当前词拼音的次数上限(每局用完就没了)。
 * 简单/练习本来就一直显示、地狱不给这个机会,留 0 表示没有这个机制。
 * 只在客户端生效,不影响计分与反作弊——玩起来看没看提示,最终还是要把这个词
 * 原原本本打出来,判定流水线一个字没变。
 */
export const PINYIN_HINT_BUDGET: Record<Difficulty, number> = {
  practice: 0,
  easy: 0,
  normal: 5,
  hard: 2,
  hell: 0,
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  practice: '练习(不限时,带拼音提示)',
  easy: '简单(带拼音提示)',
  normal: '普通',
  hard: '困难',
  hell: '地狱',
};

/** 输入模式的界面文案。纯前端渲染表,和难度文案一样不需要跨端同步。 */
export const INPUT_MODE_LABEL: Record<import('@eorzea/shared/battle').InputMode, string> = {
  composed: '组合输入',
  sequential: '逐字输入',
};

export const INPUT_MODE_HINT: Record<import('@eorzea/shared/battle').InputMode, string> = {
  composed: '可以先打完再回头改,输入框变绿才算过',
  sequential: '一旦打错就立刻结算,不给修改机会',
};
