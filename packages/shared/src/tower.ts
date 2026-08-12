/**
 * 爬塔:100 层,一层一次小遭遇,清完给几条岔路让你挑下一层。
 *
 * ★★★ 设计前提:**一张美术资源都不加**。塔的内容量全部来自把已有的几个
 *   参数拆开重组 —— 词长(DIFFICULTY_WORD_LENGTH)、限时
 *   (DIFFICULTY_WORD_TIMEOUT_MS)、输入模式(逐字/组合)、打字模式
 *   (汉字/拼音)、要打几个词、扣多少血。这几个维度现在是被「难度」这一个
 *   开关绑死的,拆开之后就是几十种组合,每一种都有明显不同的手感。
 *
 * ★ 一轮爬塔 = 一个 seed。楼层内容和岔路选项都由 seed + 层号推出来,
 *   所以同一个 seed 的塔是同一座塔 —— 这条让「每日爬塔」「赛事爬塔」
 *   几乎是白送的(复用 challenge.ts 那套 seed 机制)。
 *
 * ★ 这里只有纯逻辑:生成楼层、算岔路、算数值。渲染和运行时状态在
 *   apps/web 的 TowerScene 里,方便单测。
 */
import { createRng } from './rng';
import type { Difficulty, InputMode } from './battle';
import type { TypingMode } from './types';

export const TOWER_FLOORS = 100;
/** 每多少层一个 Boss 层 */
export const TOWER_BOSS_EVERY = 10;
/** 每层给几条岔路 */
export const TOWER_ROUTE_CHOICES = 3;

/**
 * 岔路类型。每一种只改动一两个参数,让手感差别一眼能说清 ——
 * 玩家在选路口时必须能立刻明白「这条路难在哪」,不然选择就没有意义。
 */
export type TowerRouteId =
  | 'swift'      // 速攻:限时收紧,词少
  | 'long'       // 长词:只出长词
  | 'pinyin'     // 拼音:强制拼音模式
  | 'precise'    // 精准:强制逐字输入,打错就没这个词了
  | 'rest'       // 休整:词少、回血
  | 'elite';     // 精英:词多、扣血重,过了给的血也多

export interface TowerRouteDef {
  id: TowerRouteId;
  name: string;
  /** 一句话说清这条路难在哪,直接显示在岔路卡片上 */
  blurb: string;
}

export const TOWER_ROUTES: Record<TowerRouteId, TowerRouteDef> = {
  swift: { id: 'swift', name: '疾风道', blurb: '词少但限时更紧' },
  long: { id: 'long', name: '长句廊', blurb: '只出长词,时间给得也多' },
  pinyin: { id: 'pinyin', name: '音韵阶', blurb: '强制拼音输入' },
  precise: { id: 'precise', name: '刃走廊', blurb: '逐字输入,打错立刻算失手' },
  rest: { id: 'rest', name: '静室', blurb: '词很少,通过后回血' },
  elite: { id: 'elite', name: '精英间', blurb: '词多、失手扣血重,回报也高' },
};

/** 一层的完整配置。TowerScene 直接把这些参数喂给 SoloBattle */
export interface TowerFloor {
  floor: number;
  route: TowerRouteId;
  isBoss: boolean;
  /** 打对几个词算过这一层 */
  words: number;
  difficulty: Difficulty;
  inputMode: InputMode;
  mode: TypingMode;
  /** 词长区间(判定字符数),覆盖难度自带的区间 */
  wordLength: readonly [number, number];
  /** 普通词限时(毫秒) */
  wordTimeoutMs: number;
  /** 每次失手扣多少血 */
  damageOnMiss: number;
  /** 过了这一层回多少血(静室才有) */
  healOnClear: number;
}

/** 塔里每一层的基准词数,越往上越长 */
function baseWords(floor: number): number {
  if (floor <= 10) return 4;
  if (floor <= 30) return 5;
  if (floor <= 60) return 6;
  return 7;
}

/**
 * 基准限时(毫秒)。塔自己一套曲线,不复用 DIFFICULTY_WORD_TIMEOUT_MS ——
 * 那张表是给「一整局」设计的,塔要的是随层数平滑收紧。
 */
function baseTimeoutMs(floor: number): number {
  // 第 1 层 14 秒,到第 100 层收到 6 秒,线性收紧
  const t = 14_000 - Math.round((floor - 1) / (TOWER_FLOORS - 1) * 8_000);
  return Math.max(6_000, t);
}

/** 基准失手扣血,越往上越疼 */
function baseDamage(floor: number): number {
  if (floor <= 20) return 8;
  if (floor <= 50) return 12;
  if (floor <= 80) return 16;
  return 20;
}

/**
 * 生成某一层在某条岔路下的配置。
 * 纯函数:同一个 (seed, floor, route) 永远得到同一份配置。
 */
export function buildTowerFloor(seed: string, floor: number, route: TowerRouteId): TowerFloor {
  const isBoss = floor % TOWER_BOSS_EVERY === 0;
  let words = baseWords(floor);
  let timeout = baseTimeoutMs(floor);
  let damage = baseDamage(floor);
  let wordLength: readonly [number, number] = [2, 6];
  let inputMode: InputMode = 'composed';
  let mode: TypingMode = 'hanzi';
  let heal = 0;

  switch (route) {
    case 'swift':
      words = Math.max(3, words - 1);
      timeout = Math.round(timeout * 0.65);
      break;
    case 'long':
      wordLength = [5, 7];
      timeout = Math.round(timeout * 1.25);
      break;
    case 'pinyin':
      mode = 'pinyin';
      // 拼音要敲的字符多得多,不给足时间这条路会变成纯劝退
      timeout = Math.round(timeout * 1.5);
      break;
    case 'precise':
      inputMode = 'sequential';
      words = Math.max(3, words - 1);
      break;
    case 'rest':
      words = Math.max(2, words - 2);
      timeout = Math.round(timeout * 1.4);
      damage = Math.round(damage * 0.5);
      heal = 15;
      break;
    case 'elite':
      words += 3;
      damage = Math.round(damage * 1.5);
      heal = 10;
      break;
  }

  if (isBoss) {
    // Boss 层:词更多、扣血更重。机制由 TowerScene 那边挂上(复用现有三个机制)
    words += 2;
    damage = Math.round(damage * 1.25);
  }

  return {
    floor,
    route,
    isBoss,
    words,
    // 难度只用来给战斗引擎一个基准档位,真正生效的是上面这几个覆盖值
    difficulty: 'hard',
    inputMode,
    mode,
    wordLength,
    wordTimeoutMs: timeout,
    damageOnMiss: damage,
    healOnClear: heal,
  };
}

/**
 * 下一层能选哪几条路。
 *
 * ★ 保证「至少有一条不是硬碰硬」:每组选项里必定包含 rest 或 swift 之一。
 *   全是精英/长词的路口会让血少的人直接卡死,roguelike 的乐趣是权衡,
 *   不是被随机数判死刑。
 * ★ Boss 层不给选 —— 到点就是 Boss,这是塔的节奏锚点。
 */
export function routeChoicesFor(seed: string, floor: number): TowerRouteId[] {
  if (floor % TOWER_BOSS_EVERY === 0) return ['elite'];

  const rng = createRng(`${seed}:routes:${floor}`);
  const all: TowerRouteId[] = ['swift', 'long', 'pinyin', 'precise', 'rest', 'elite'];
  // Fisher-Yates 洗牌后取前几个,保证同一组里不会重复出现同一条路
  const bag = all.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const picked = bag.slice(0, TOWER_ROUTE_CHOICES);

  const safe: TowerRouteId[] = ['rest', 'swift'];
  if (!picked.some((r) => safe.includes(r))) {
    // 把最后一个换成一条「缓一缓」的路,保证每个路口都有退路
    picked[picked.length - 1] = safe[rng.int(safe.length)];
  }
  return picked;
}
