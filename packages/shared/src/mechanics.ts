/**
 * Boss 特殊机制。
 *
 * ★★★ 这个文件是「加新机制」的唯一入口。想再加一个机制,按下面四步走,
 *     不需要动战斗场景的主流程:
 *       1. 往 MechanicId 加一个 id
 *       2. 往 MECHANICS 加一条定义(叫什么、怎么触发、要几个词、给多久)
 *       3. 如果它有专属状态(位置、顺序之类),往 MechanicState 加一个可选字段,
 *          并写一个 `submitXxx` 纯函数推进它
 *       4. 前端加一个展示组件,在 MechanicPanel 里按 id 分派
 *     判定与推进全部是纯函数、不碰 DOM 也不碰计时器,服务端和客户端共用同一份。
 *
 * ★ 为什么触发方式要抽象成 trigger 而不是各写各的:
 *   泰坦之怒是「每次普通词结算后按概率」,三连桶/三穿一是「Boss 血量跌破某个
 *   百分比」。这两类触发时机完全不同,但战斗场景只想调一个函数问「现在该不该
 *   出机制」。把差异关在这里,场景那边就永远只有一行。
 */
import type { WordEntry } from './types';
import type { Difficulty } from './battle';
import { DIFFICULTY_CAST_DURATION_MS, MAX_INTERRUPT_WORD_LENGTH } from './battle';
import { buildSequence } from './wordbank';

export type MechanicId = 'titan_wrath' | 'three_barrels' | 'three_pierce';

/**
 * 触发方式。
 * - `word_settle_chance`:每次普通词结算后掷一次骰子(泰坦之怒走这条,概率由
 *   battle.ts 的保底规则算,不在这里定)。
 * - `boss_hp_threshold`:Boss 血量比例**跌破**某个阈值时触发,每个阈值一局
 *   只触发一次。`chance` 为 1 表示必定触发。
 */
export type MechanicTrigger =
  | { kind: 'word_settle_chance' }
  | { kind: 'boss_hp_threshold'; thresholds: readonly number[]; chance: number };

export interface MechanicDef {
  id: MechanicId;
  name: string;
  /** 一句话说明,直接显示给玩家 */
  hint: string;
  trigger: MechanicTrigger;
  /** 这次机制需要玩家打几个词 */
  wordCount: number;
  /** 词长上限。机制都是短时挑战,不该出长词 */
  maxWordLength: number;
  /** 时限相对该难度读条窗口的倍数 */
  durationMultiplier: number;
}

/**
 * 机制注册表。
 *
 * 阈值的分配理由:三连桶是位移类、容错高(打错只是原地不动),放在前面的 67%;
 * 三穿一要连打三个词且不能乱序,难度更高,放在血量已经掉了三分之二的 33%。
 * 无限模式没有「打完这一只就结束」的节奏,所以改成四个阈值各自按概率触发,
 * 免得每只泰坦的流程都一模一样。
 */
export const MECHANICS: Record<MechanicId, MechanicDef> = {
  titan_wrath: {
    id: 'titan_wrath',
    name: '泰坦之怒',
    hint: '限时打完这个词,否则全队扣血',
    trigger: { kind: 'word_settle_chance' },
    wordCount: 1,
    maxWordLength: MAX_INTERRUPT_WORD_LENGTH,
    durationMultiplier: 1,
  },
  three_barrels: {
    id: 'three_barrels',
    name: '三连桶',
    hint: '打对应方向的词左右挪动,躲到中间的石头后面',
    trigger: { kind: 'boss_hp_threshold', thresholds: [0.67], chance: 1 },
    // 一次给左右两个词,玩家选一个打;要走几步由 BARREL_LANE_SIZE 决定
    wordCount: 2,
    maxWordLength: MAX_INTERRUPT_WORD_LENGTH,
    durationMultiplier: 2,
  },
  three_pierce: {
    id: 'three_pierce',
    name: '三穿一',
    hint: '按标注的顺序依次打完三个词',
    trigger: { kind: 'boss_hp_threshold', thresholds: [0.33], chance: 1 },
    wordCount: 3,
    maxWordLength: MAX_INTERRUPT_WORD_LENGTH,
    durationMultiplier: 2,
  },
};

/** 无限模式的阈值:泰坦一只接一只,固定流程会腻,所以改成四个点各自掷骰子 */
export const ENDLESS_MECHANIC_THRESHOLDS: readonly number[] = [0.8, 0.6, 0.4, 0.2];
export const ENDLESS_MECHANIC_CHANCE = 0.5;

/** 三连桶的赛道格数与石头位置(0-indexed)。石头固定在正中。 */
export const BARREL_LANE_SIZE = 5;
export const BARREL_STONE_INDEX = 2;

export function mechanicDurationMs(id: MechanicId, difficulty: Difficulty): number {
  return Math.round(DIFFICULTY_CAST_DURATION_MS[difficulty] * MECHANICS[id].durationMultiplier);
}

// ─────────────────────────── 触发判定 ───────────────────────────

/**
 * Boss 血量从 prevRatio 掉到 curRatio 期间跨过了哪些阈值。
 * 严格「跨过」语义(prev > t >= cur),所以同一个阈值一局只会命中一次 ——
 * 不需要额外维护「哪些已经触发过」的集合,血量单调下降本身就保证了这一点。
 */
export function crossedThresholds(
  thresholds: readonly number[],
  prevRatio: number,
  curRatio: number,
): number[] {
  return thresholds.filter((t) => prevRatio > t && curRatio <= t);
}

/**
 * Boss 掉血之后,该触发哪个血量阈值类机制?没有就返回 null。
 * 同时跨过多个阈值时取更低的那个(掉血量大时优先给更靠后、更难的机制)。
 */
export function mechanicForHpDrop(
  prevRatio: number,
  curRatio: number,
  roll: number,
): MechanicId | null {
  let hit: { id: MechanicId; threshold: number } | null = null;
  for (const def of Object.values(MECHANICS)) {
    if (def.trigger.kind !== 'boss_hp_threshold') continue;
    const crossed = crossedThresholds(def.trigger.thresholds, prevRatio, curRatio);
    if (crossed.length === 0) continue;
    if (roll >= def.trigger.chance) continue;
    const lowest = Math.min(...crossed);
    if (!hit || lowest < hit.threshold) hit = { id: def.id, threshold: lowest };
  }
  return hit ? hit.id : null;
}

// ─────────────────────────── 运行时状态 ───────────────────────────

export interface BarrelState {
  /** 玩家当前所在格 */
  position: number;
  laneSize: number;
  stoneIndex: number;
  /** 往左走要打的词 / 往右走要打的词 */
  leftWord: WordEntry;
  rightWord: WordEntry;
}

export interface PierceState {
  words: WordEntry[];
  /** words 的下标顺序,玩家必须照这个顺序打 */
  order: number[];
  /** 已经按顺序打对了几个 */
  solved: number;
}

export interface MechanicState {
  id: MechanicId;
  /** 单词型机制(泰坦之怒)的目标词 */
  word?: WordEntry;
  barrel?: BarrelState;
  pierce?: PierceState;
  /** 相对本局的截止时刻(毫秒) */
  deadline: number;
}

/** 从池子里挑 count 个互不相同的短词。池子太小时允许重复,总比开不出机制强。 */
export function pickMechanicWords(
  pool: readonly WordEntry[],
  count: number,
  maxLength: number,
  seed: string,
): WordEntry[] {
  const short = pool.filter((e) => e.typeText.length <= maxLength);
  const src = short.length > 0 ? short : pool;
  if (src.length === 0) return [];
  // 多抽一些再去重,避免 buildSequence 在小池子上反复给出同一个词
  const drawn = buildSequence(src, Math.min(src.length, count * 4), seed);
  const seen = new Set<string>();
  const out: WordEntry[] = [];
  for (const w of drawn) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    out.push(w);
    if (out.length === count) break;
  }
  while (out.length < count && src.length > 0) out.push(src[out.length % src.length]);
  return out;
}

/**
 * 建立一次机制的初始状态。
 * `roll` 由调用方提供(0..1),用来决定三连桶的出生方向 —— 服务端用 Math.random,
 * 客户端联机时不自己算(状态由服务端下发)。
 */
export function createMechanicState(
  id: MechanicId,
  pool: readonly WordEntry[],
  difficulty: Difficulty,
  nowMs: number,
  seed: string,
  roll: number,
): MechanicState | null {
  const def = MECHANICS[id];
  const words = pickMechanicWords(pool, def.wordCount, def.maxWordLength, seed);
  if (words.length < def.wordCount) return null;
  const deadline = nowMs + mechanicDurationMs(id, difficulty);

  if (id === 'three_barrels') {
    return {
      id,
      deadline,
      barrel: {
        // 只在最左或最右出生,不会一开局就贴着石头
        position: roll < 0.5 ? 0 : BARREL_LANE_SIZE - 1,
        laneSize: BARREL_LANE_SIZE,
        stoneIndex: BARREL_STONE_INDEX,
        leftWord: words[0],
        rightWord: words[1],
      },
    };
  }
  if (id === 'three_pierce') {
    // 顺序也由 seed 决定,联机两端才能算出同一个顺序
    const order = buildSequence(
      words.map((_, i) => ({ ...words[i], id: String(i) })),
      words.length,
      `${seed}:order`,
    ).map((w) => Number(w.id));
    const uniq = Array.from(new Set(order));
    for (let i = 0; i < words.length; i++) if (!uniq.includes(i)) uniq.push(i);
    return { id, deadline, pierce: { words, order: uniq.slice(0, words.length), solved: 0 } };
  }
  return { id, deadline, word: words[0] };
}

// ─────────────────────────── 推进(纯函数) ───────────────────────────

export type MechanicOutcome =
  /** 这次输入不对,机制继续 */
  | { kind: 'rejected'; state: MechanicState }
  /** 有进展但还没完成 */
  | { kind: 'progress'; state: MechanicState }
  /** 机制完成 */
  | { kind: 'cleared' };

/**
 * 往机制里提交一次「打完的词」。
 *
 * 判定只看 wordId —— 文本对不对由调用方用 judgeInput 判过了(前端在
 * useTypingInput 里判,服务端在 handleWordAttempt 里判),这里只负责推进状态机。
 */
export function submitMechanicWord(state: MechanicState, wordId: string): MechanicOutcome {
  if (state.id === 'three_barrels' && state.barrel) {
    const b = state.barrel;
    const dir = wordId === b.leftWord.id ? -1 : wordId === b.rightWord.id ? 1 : 0;
    // 打错方向词:原地不动(需求明确要求),不是往回走、也不是直接失败
    if (dir === 0) return { kind: 'rejected', state };
    const position = Math.max(0, Math.min(b.laneSize - 1, b.position + dir));
    if (position === b.stoneIndex) return { kind: 'cleared' };
    return { kind: 'progress', state: { ...state, barrel: { ...b, position } } };
  }

  if (state.id === 'three_pierce' && state.pierce) {
    const p = state.pierce;
    const expected = p.words[p.order[p.solved]];
    // 打错顺序:那一个作废重打,已经打对的不回退,计时也不停
    if (!expected || expected.id !== wordId) return { kind: 'rejected', state };
    const solved = p.solved + 1;
    if (solved >= p.words.length) return { kind: 'cleared' };
    return { kind: 'progress', state: { ...state, pierce: { ...p, solved } } };
  }

  // 单词型:打对即完成
  return state.word && state.word.id === wordId ? { kind: 'cleared' } : { kind: 'rejected', state };
}

/** 机制当前该打的目标词。三连桶有左右两个,由 UI 同时展示、玩家自己选。 */
export function currentMechanicWords(state: MechanicState): WordEntry[] {
  if (state.id === 'three_barrels' && state.barrel) {
    return [state.barrel.leftWord, state.barrel.rightWord];
  }
  if (state.id === 'three_pierce' && state.pierce) {
    const p = state.pierce;
    const next = p.words[p.order[p.solved]];
    return next ? [next] : [];
  }
  return state.word ? [state.word] : [];
}
