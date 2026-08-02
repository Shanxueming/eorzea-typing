/**
 * 战斗相关的共用常量与词序列生成器。
 *
 * buildSequence 一次只给定长度,而战斗时长不确定,所以按批次续接;
 * 单机与联机(服务端与客户端各自用同一个 seed 独立调用)都走这份逻辑,
 * 保证词序完全一致 —— 这是 M3 协议"只下发 seed,不下发词序"的地基。
 *
 * 这是新增文件,不在 §1 的八个只读文件之列。
 */
import type { WordEntry } from './types';
import { buildSequence } from './wordbank';
import { THRESHOLDS } from './anticheat';

export const BOSS_MAX_HP = 6000;
/** 狂暴倒计时：原 120 秒基础上延长 50%。 */
export const BATTLE_DURATION_MS = 180_000;
/** Boss 读条间隔的随机区间(毫秒) */
export const CAST_INTERVAL_MS: [number, number] = [8000, 15000];
export const CAST_DURATION_MS = 5000;
export const PLAYER_MAX_HP = 100;
/** 打错普通词的扣血量,比打断/躲避失败轻得多 */
export const PLAYER_DAMAGE_ON_MISS = 5;
/** 打断(躲避 Boss 读条)失败的扣血量 */
export const PLAYER_DAMAGE_ON_FAIL = 25;
/** 打断成功的回血量 —— 有奖励才有人愿意冒险抢读条 */
export const PLAYER_HEAL_ON_INTERRUPT = 15;
/**
 * 普通词也限时,不再是打到天荒地老:超时按一次 miss 处理(扣血、清连击、
 * 换下一个词)。限时是这局读条时长(已经按难度换算过)的倍数,不是固定值——
 * 难度越松,读条越长,普通词给的时间也跟着松。
 */
export const NORMAL_WORD_TIMEOUT_MULTIPLIER = 2.5;
/** 读条正式开始前的预警时长,让玩家有个心理准备,预警阶段不能打断 */
export const CAST_WARNING_MS = 1000;
/** 普通词成功/失败结算后触发泰坦之怒的概率。读条不再按墙钟定时抢断正常输入。 */
export const TITAN_WRATH_ON_SUCCESS_CHANCE = 0.15;
export const TITAN_WRATH_ON_FAILURE_CHANCE = 0.25;
/** 泰坦之怒是短时挑战，只使用不超过四个判定字符的词。 */
export const MAX_INTERRUPT_WORD_LENGTH = 4;
export const BOSS_NAME = '泰坦';
export const BOSS_SKILL_NAME = '泰坦之怒';

/**
 * Item 表没有「料理/药品/家具」等子类字段，只能按名称判断。这里保留明确的 FF14
 * 世界观名词：幻想药、圣灵药，以及带地域、种族、蛮神、古文明等标识的装备与料理。
 * 新发现的漏网普通物品应优先补充这个清单，而不是再把整个 items 分类一刀切掉。
 */
export const FEATURED_ITEM_NAME_MARKERS = [
  '幻想药', '圣灵药', '艾欧泽亚', '海德林', '佐迪亚克', '以太', '水晶', '蛮神',
  '亚拉戈', '阿拉米格', '伊修加德', '格里达尼亚', '利姆萨', '拉诺西亚', '萨纳兰',
  '乌尔达哈', '摩杜纳', '库尔札斯', '黑衣森林', '基拉巴尼亚', '多玛', '延夏',
  '加雷马', '萨雷安', '萨维奈', '拉扎罕', '厄尔庇斯', '埃尔皮斯', '尼姆', '玛哈',
  '伊甸', '欧米茄', '巴哈姆特', '莫古力', '陆行鸟', '冬贝利', '哥布林', '拉拉菲尔',
  '鲁加', '猫魅', '维埃拉', '敖龙', '泰坦', '伊弗利特', '迦楼罗', '利维亚桑', '拉姆',
] as const;

export function isFeaturedItem(entry: WordEntry): boolean {
  return entry.category !== 'items'
    || FEATURED_ITEM_NAME_MARKERS.some((marker) => entry.typeText.includes(marker));
}

/** 原始词库不改动；单机与联机在生成词序列前调用同一规则，保证词序一致。 */
export function filterFeaturedWordPool(pool: readonly WordEntry[]): WordEntry[] {
  return pool.filter(isFeaturedItem);
}

/**
 * 三档难度。只影响读条时长的倍数(CAST_DURATION_MS 是基准值);
 * 单机与联机(服务端权威决定这局用哪档)共用同一份倍数,不要出现两份数字。
 */
export type Difficulty = 'easy' | 'normal' | 'hard' | 'hell';

export const DIFFICULTY_CAST_MULTIPLIER: Record<Difficulty, number> = {
  easy: 2.5,
  normal: 2,
  hard: 1.25,
  hell: 0.75,
};

export type TrustVerdict = 'verified' | 'unverified' | 'rejected';

/**
 * PlayerResult 只带 trustScore,不带现成的 verdict 字段,结算页要展示三种
 * 徽章就得自己分档——用和 analyzeSession 完全一样的阈值,保证判断口径一致。
 */
export function verdictOf(trustScore: number): TrustVerdict {
  if (trustScore >= THRESHOLDS.TRUST_VERIFIED) return 'verified';
  if (trustScore >= THRESHOLDS.TRUST_REJECT) return 'unverified';
  return 'rejected';
}

const BATCH_SIZE = 200;

export interface WordQueue {
  next(): WordEntry;
}

export function createWordQueue(pool: readonly WordEntry[], seed: string): WordQueue {
  if (pool.length === 0) {
    throw new Error('word pool is empty');
  }
  let batchIndex = 0;
  let buffer: WordEntry[] = [];
  let cursor = 0;

  function fill(): void {
    buffer = buildSequence(pool, Math.min(BATCH_SIZE, pool.length), `${seed}:${batchIndex}`);
    batchIndex += 1;
    cursor = 0;
  }

  return {
    next(): WordEntry {
      if (cursor >= buffer.length) fill();
      return buffer[cursor++];
    },
  };
}

/**
 * 从普通词池中选一个短打断词。长度按 typeText 计算，而非展示文本，确保带标点的
 * 词条仍以玩家实际需要输入的字符数为准；没有合格词时返回 null，绝不退回长词。
 */
export function pickShortInterruptWord(pool: readonly WordEntry[], seed: string): WordEntry | null {
  const short = pool.filter((entry) => entry.typeText.length <= MAX_INTERRUPT_WORD_LENGTH);
  const hard = short.filter((entry) => entry.difficulty === 3);
  const mid = short.filter((entry) => entry.difficulty === 2);
  const src = hard.length > 0 ? hard : mid.length > 0 ? mid : short;
  return src.length > 0 ? buildSequence(src, 1, seed)[0] : null;
}
