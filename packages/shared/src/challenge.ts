/**
 * 挑战赛道:让「同一个 seed」真的等于「同一局」。
 *
 * ★★★ 为什么需要这个文件 ——
 *   普通模式里机制(泰坦之怒/三连桶/三穿一)是**按玩家表现随机掷骰**触发的:
 *   打对用 TITAN_WRATH_ON_SUCCESS_CHANCE、打错用 ON_FAILURE,还叠了 pity
 *   计数器;血量阈值机制则取决于累计伤害(而伤害取决于连击)。这意味着两个
 *   水平不同的玩家哪怕拿到同一个 seed、同一条词序列,从第一次失误开始机制
 *   就会分叉——机制次数、位置、机制词全都不一样。
 *   **所以"大家打同一批词"这件事,靠统一 seed 是做不到公平的。**
 *
 *   挑战赛道(每日挑战 / 赛事)改用「排程」:由 seed 一次性算出整局的剧本
 *   ——第几个词之后触发哪个机制、机制用哪些词、三连桶从哪边出生——和玩家
 *   打得怎么样完全无关。所有人拿到一模一样的剧本,像固定赛道一样可比。
 *
 * ★ 普通模式不受影响:它继续走原来那套随机 + pity 的手感,这个文件只服务
 *   固定 seed 的赛道。战斗场景靠「有没有传 script」来切换两种行为。
 *
 * ★ 这里的算法一旦上线就不能随意改 —— 改了同一个 seed 会算出不同的剧本,
 *   历史成绩之间就不可比了(理由同 rng.ts 顶部的说明)。
 */
import { createRng } from './rng';
import type { MechanicId } from './mechanics';

/** 两次机制之间至少隔几个普通词 */
export const CHALLENGE_MECHANIC_MIN_GAP = 5;
/** 两次机制之间最多隔几个普通词 */
export const CHALLENGE_MECHANIC_MAX_GAP = 9;
/**
 * 剧本预排到第几个词为止。标准模式 180 秒、困难档限时 10 秒一个词,
 * 理论上限也就几十个词;排到 300 是给无限模式留的余量,排满也只有几十条,
 * 生成一次的开销可以忽略。
 */
export const CHALLENGE_SCRIPT_WORDS = 300;

/** 参与轮换的机制。顺序不重要(下面是随机取),但**集合不能随意增删** —— 见文件头 */
const SCHEDULED_MECHANIC_IDS: readonly MechanicId[] = ['titan_wrath', 'three_barrels', 'three_pierce'];

export interface ScheduledMechanic {
  /** 在第几个普通词结算之后触发。1 = 第一个普通词打完(或打错)之后 */
  afterWord: number;
  id: MechanicId;
}

export interface ChallengeScript {
  /** 生成这份剧本用的战斗 seed,存档/校验时对得上 */
  seed: string;
  /** 按 afterWord 升序排列,同一个 afterWord 只会有一条 */
  mechanics: readonly ScheduledMechanic[];
}

/**
 * 由 seed 算出整局的机制剧本。纯函数 —— 同一个 seed 在任何机器、任何时刻
 * 都会得到完全相同的结果,这正是挑战赛道可比性的地基。
 */
export function buildChallengeScript(seed: string): ChallengeScript {
  const rng = createRng(`${seed}:script`);
  const mechanics: ScheduledMechanic[] = [];
  let at = 0;
  for (;;) {
    at += rng.range(CHALLENGE_MECHANIC_MIN_GAP, CHALLENGE_MECHANIC_MAX_GAP);
    if (at > CHALLENGE_SCRIPT_WORDS) break;
    mechanics.push({ afterWord: at, id: SCHEDULED_MECHANIC_IDS[rng.int(SCHEDULED_MECHANIC_IDS.length)] });
  }
  return { seed, mechanics };
}

/**
 * 第 wordIndex 个普通词结算之后该不该触发机制、触发哪个。
 * wordIndex 从 1 开始数,和 ScheduledMechanic.afterWord 同一口径。
 */
export function mechanicAt(script: ChallengeScript, wordIndex: number): MechanicId | null {
  const hit = script.mechanics.find((m) => m.afterWord === wordIndex);
  return hit ? hit.id : null;
}

/**
 * 这一次机制该用的 seed。**不能带墙钟时间**——普通模式里用的是
 * `${seed}:${id}:${Math.floor(now())}`,同一个 seed 每次跑出来的机制词都不同,
 * 那正是挑战赛道要消除的东西。这里只用「第几个词」定位,人人都算得出同一个值。
 */
export function challengeMechanicSeed(seed: string, wordIndex: number): string {
  return `${seed}:mech:${wordIndex}`;
}

/**
 * 这一次机制该用的 roll(0..1)。createMechanicState 拿它决定三连桶从哪边出生,
 * 同样必须由 seed + 词序号推出来,不能用 Math.random。
 */
export function challengeMechanicRoll(seed: string, wordIndex: number): number {
  return createRng(`${challengeMechanicSeed(seed, wordIndex)}:roll`).next();
}
