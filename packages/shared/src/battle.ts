/**
 * 战斗相关的共用常量与词序列生成器。
 *
 * createWordQueue 按 seed 持续发词,战斗时长不确定也不用关心——牌堆式洗牌,
 * 顺序发完再重新洗一次(见下面的实现注释);单机与联机(服务端与客户端各自
 * 用同一个 seed 独立调用)都走这份逻辑,保证词序完全一致 —— 这是 M3 协议
 * "只下发 seed,不下发词序"的地基。
 *
 * 这是新增文件,不在 §1 的八个只读文件之列。
 */
import type { WordEntry } from './types';
import { buildSequence } from './wordbank';
import { createRng } from './rng';
import { THRESHOLDS } from './anticheat';

export const BOSS_MAX_HP = 6000;

/**
 * Boss 血量按难度加厚。困难 +30%、地狱 +200%(在原先「+100%」的基础上
 * 又提了 50%,即 ×2 → ×3)—— 高难度不只是限时更紧,一局要打的总量也更大,
 * 拉开的是「能不能撑到最后」而不只是「手够不够快」。简单与普通维持基准值。
 */
export const DIFFICULTY_BOSS_HP_MULTIPLIER: Record<Difficulty, number> = {
  easy: 1,
  normal: 1,
  hard: 1.3,
  hell: 3,
};

export function bossHpFor(difficulty: Difficulty): number {
  return Math.round(BOSS_MAX_HP * DIFFICULTY_BOSS_HP_MULTIPLIER[difficulty]);
}
/** 狂暴倒计时：原 120 秒基础上延长 50%。 */
export const BATTLE_DURATION_MS = 180_000;
/** Boss 读条间隔的随机区间(毫秒) */
export const CAST_INTERVAL_MS: [number, number] = [8000, 15000];
export const CAST_DURATION_MS = 5000;
export const PLAYER_MAX_HP = 100;
/** 打断(躲避 Boss 读条)失败的扣血量。不分难度——简单难度根本不会触发读条。 */
export const PLAYER_DAMAGE_ON_FAIL = 25;
/** 打断成功的回血量 —— 有奖励才有人愿意冒险抢读条 */
export const PLAYER_HEAL_ON_INTERRUPT = 15;
/** 读条正式开始前的预警时长,让玩家有个心理准备,预警阶段不能打断 */
export const CAST_WARNING_MS = 1000;

/**
 * 普通词限时,按难度直接给定值(毫秒)。
 *
 * ★ 以前这个值是「读条时长 × 2.5」推导出来的,两者被一个倍数锁死;现在两张表
 *   彼此独立 —— 调普通词的松紧不会连带改变读条窗口,反之亦然。想调手感直接改
 *   下面这两张表,不要再引入新的推导关系。
 */
export const DIFFICULTY_WORD_TIMEOUT_MS: Record<Difficulty, number> = {
  easy: 25_000,
  normal: 16_000,
  hard: 12_000,
  hell: 9_000,
};

/**
 * 泰坦之怒的读条窗口(毫秒),即玩家必须在多久内打完打断词。
 * easy 这一档的值实际用不到 —— 简单难度不触发泰坦之怒(见 titanWrathChance),
 * 留一个合理值只是为了让这张表在类型上完整、将来放开时不必现编。
 */
export const DIFFICULTY_CAST_DURATION_MS: Record<Difficulty, number> = {
  easy: 12_000,
  normal: 10_000,
  hard: 6_500,
  hell: 5_000,
};

/** 打错/超时一个普通词的扣血量,按难度递增。打断失败另算(PLAYER_DAMAGE_ON_FAIL)。 */
export const DIFFICULTY_DAMAGE_ON_MISS: Record<Difficulty, number> = {
  easy: 3,
  normal: 5,
  hard: 10,
  hell: 20,
};

/**
 * 普通词成功/失败结算后触发泰坦之怒的**基础**概率。读条不再按墙钟定时抢断
 * 正常输入。实际概率还要过一遍下面的保底规则,不要直接拿这两个值判定。
 */
export const TITAN_WRATH_ON_SUCCESS_CHANCE = 0.15;
export const TITAN_WRATH_ON_FAILURE_CHANCE = 0.25;

/** 简单难度是纯练手档:只打词、不躲技能,泰坦之怒一次都不会出现。 */
export function hasTitanWrath(difficulty: Difficulty): boolean {
  return difficulty !== 'easy';
}

/**
 * 泰坦之怒保底(pity)。
 *
 * 规则一:每多打一个词,触发概率在基础值上累加 PITY_STEP,封顶 PITY_CAP;
 *         一旦触发就把计数清零重新攒。解决的是「运气差时整局不出读条」。
 * 规则二:触发后 COOLDOWN_WORDS 个词内必定不触发,避免连着炸两次没法喘气。
 *         **地狱难度不吃这条冷却**——那一档就是要没有安全窗口。
 *
 * 计数器口径:「距上次泰坦之怒结束后又结算了几个普通词」,打对打错都算数,
 * 成功与失败两条路径共用同一个计数器,只是基础概率不同。联机时这个计数器是
 * **全房一份**(泰坦之怒本来就是全房共享的一次事件),不是每人一份。
 */
export const TITAN_WRATH_PITY_STEP = 0.05;
export const TITAN_WRATH_PITY_CAP = 0.9;
export const TITAN_WRATH_COOLDOWN_WORDS = 3;

/**
 * 算出这一次结算实际该用的泰坦之怒触发概率。
 * @param baseChance          基础概率,打对用 ON_SUCCESS,打错用 ON_FAILURE
 * @param wordsSinceLastWrath 距上次泰坦之怒之后已经结算了几个普通词
 */
export function titanWrathChance(
  baseChance: number,
  wordsSinceLastWrath: number,
  difficulty: Difficulty,
): number {
  if (!hasTitanWrath(difficulty)) return 0;
  if (difficulty !== 'hell' && wordsSinceLastWrath < TITAN_WRATH_COOLDOWN_WORDS) return 0;
  const pity = Math.max(0, wordsSinceLastWrath) * TITAN_WRATH_PITY_STEP;
  return Math.min(TITAN_WRATH_PITY_CAP, baseChance + pity);
}
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
 * 难度分布:每档难度出几个字的词,闭区间 [最少, 最多]。
 *
 * ★ 这里按**判定字符数**(`typeText.length`)筛,不用 `WordEntry.difficulty`。
 *   那个字段只有 1/2/3 三档(≤3 字 / 4~6 字 / ≥7 字),粒度太粗,表达不了
 *   「3~7 字」这种跨档的区间。字数是玩家真正感受到的东西,直接按它筛最直观。
 *
 * 这是拉开难度差距的主力 —— 在这之前四个档位打的是同一批词、只有时限不同,
 * 而时限对熟练玩家几乎不构成压力。
 */
export const DIFFICULTY_WORD_LENGTH: Record<Difficulty, readonly [number, number]> = {
  easy: [1, 3],
  normal: [1, 6],
  hard: [3, 7],
  // ★ 地狱刻意与困难共用同一批词,不往上堆字数:它的难度来自 9 秒限时 +
  //   强制逐字输入(打错一个字立刻判负),再叠一层超长词只会变成纯粹的折磨,
  //   而不是更高的技巧上限。
  hell: [3, 7],
};

/**
 * 按难度筛出这一局的普通词池。
 *
 * ★★★ 联机的服务端与客户端**必须调用同一个函数、传同一个 difficulty**。
 *     词池只要差一条,`createWordQueue` 生成的序列就完全不同,两边从第一个词
 *     起全错位,后果和真的队列错位一模一样(提交被服务端静默丢弃)。
 *
 * 筛完为空时退回原池而不是抛错:宁可这一局的难度分布不生效,也不能让玩家
 * 开不了局 —— 自定义分类下玩家完全可能只勾了一批清一色短词的分类。
 */
export function filterPoolByDifficulty(
  pool: readonly WordEntry[],
  difficulty: Difficulty,
): WordEntry[] {
  const [min, max] = DIFFICULTY_WORD_LENGTH[difficulty];
  // 用 typeText 而不是 text:玩家实际要敲的是判定文本,「必杀剑·九天」显示
  // 六个字符但只需要打五个,按展示文本筛会让字数区间对不上手感。
  const filtered = pool.filter((entry) => entry.typeText.length >= min && entry.typeText.length <= max);
  return filtered.length > 0 ? filtered : [...pool];
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

/**
 * 输入模式。注意这和 `TypingMode`('hanzi' | 'pinyin')是**两个正交维度**:
 * TypingMode 决定「打汉字还是打拼音」,InputMode 决定「怎么算打错」。
 *
 * - `sequential` 逐字:沿用最初的判定,输入一旦不再是目标词的前缀就算打错
 *   (地狱直接判负,其余难度清空重来)。
 * - `composed`   组合:缓存区语义。输入随便改,不匹配只把输入框染红、既不判负
 *   也不清空,玩家可以退格修正;内容**完全等于**目标词才算过。
 *
 * ★ 判定函数本身一个字没改 —— `judgeInput` 返回的四个状态
 *   (empty/progress/error/complete)对两种模式都够用,区别只在战斗场景怎么
 *   响应 `error`。所以只读的 scoring.ts / typingReducer.ts 不需要动。
 */
export type InputMode = 'sequential' | 'composed';

// ─────────────────────────── 游戏模式 ───────────────────────────

/**
 * 玩法模式。
 * - `standard` 标准:打 BATTLE_DURATION_MS 这一局,把泰坦打死算通关,时间到算失败。
 * - `endless`  无限:没有狂暴倒计时,泰坦打死一只立刻刷下一只、血量逐只加厚,
 *              **玩家血量归零才结束**。比的是能扛到第几只。
 */
export type GameMode = 'standard' | 'endless';

/** 无限模式固定用困难难度的时限,不给玩家选 —— 排行榜要可比。 */
export const ENDLESS_DIFFICULTY: Difficulty = 'hard';

/**
 * 无限模式每击杀一只泰坦,下一只的血量乘这个系数。
 * 1.25 的意思是第 1 只 6000、第 2 只 7500、第 3 只 9375……前几只让人喘口气,
 * 到第五六只开始明显吃力,曲线比线性加更有"越打越紧"的感觉。
 */
export const ENDLESS_BOSS_HP_GROWTH = 1.25;

/**
 * 无限模式:每打倒一只泰坦,普通词的输入时限就缩短这么多——
 * 血厚(ENDLESS_BOSS_HP_GROWTH)只逼着你打得更久,这条才是逼着你打得更快,
 * 两条一起才有「越打越紧」的感觉,不然后期就是纯粹堆时间的体力活。
 */
export const ENDLESS_TIMEOUT_SHRINK_PER_KILL_MS = 300;
/** 上面那条缩减的下限,不然刷到二三十只之后时限会缩到根本打不完一个词。 */
export const ENDLESS_MIN_WORD_TIMEOUT_MS = 5_000;

export const DEFAULT_INPUT_MODE: InputMode = 'composed';

/**
 * 地狱难度只允许逐字:那一档的立身之本是「打错一个字立刻判负」,而组合输入的
 * 立身之本是「错了可以改」,两者语义互斥,不能共存于同一档。
 */
export function allowsComposedInput(difficulty: Difficulty): boolean {
  return difficulty !== 'hell';
}

/** 按难度收敛输入模式:地狱强制逐字,其余按玩家选择。UI 与判定共用这一个出口。 */
export function resolveInputMode(difficulty: Difficulty, preferred: InputMode): InputMode {
  return allowsComposedInput(difficulty) ? preferred : 'sequential';
}

// ─────────────────────────── 角色与技能 ───────────────────────────

/**
 * 可选角色。沿用既有的 p1/p2 两个槽位命名(素材路径、SkinPicker 都是这套),
 * 但从这里开始 p1/p2 不再只是「外观槽位」,而是**带主动技能的角色**;
 * 每个角色下面仍然可以有多套皮肤(assets/avatar/p1-2.png……),皮肤只影响外观。
 */
export type CharacterId = 'p1' | 'p2';

/**
 * 技能冷却。一局 BATTLE_DURATION_MS 是 180 秒,90 秒冷却意味着一把大约能开
 * 两次(开局一次、中段一次),这是需求里定的手感。开局即可用,不需要先攒。
 */
export const SKILL_COOLDOWN_MS = 90_000;

/** 「浴血」的增益覆盖几个词 */
export const BLOODBATH_WORDS = 3;
/** 「浴血」期间伤害与扣血的倍率 */
export const BLOODBATH_MULTIPLIER = 1.5;
/** 「浴血」期间普通词限时的缩放(减少 25%) */
export const BLOODBATH_TIME_SCALE = 0.75;

/**
 * 「原初的解放」的追加效果:换完词之后紧接着的下一个词,打成功就回血;
 * 但满血状态下回血没有意义,所以改成让那个词的伤害翻倍——同一份增益,
 * 缺血时保命、满血时爆发,不会出现「已经满血,这次技能等于白开」的情况。
 */
export const PRIMAL_RELEASE_HEAL = 10;
export const PRIMAL_RELEASE_DAMAGE_MULTIPLIER = 2;

export interface SkillDef {
  id: string;
  name: string;
  character: CharacterId;
  description: string;
}

export const SKILLS: Record<CharacterId, SkillDef> = {
  p1: {
    id: 'primal_release',
    name: '原初的解放',
    character: 'p1',
    // ★ 换词本身不对 Boss 造成任何伤害;价值在于「跳过难词而连击不断」,
    //   外加下面这条追加效果(见 PRIMAL_RELEASE_HEAL 的注释)。
    description: `跳过当前词,连击不中断。下一个词打成功回复 ${PRIMAL_RELEASE_HEAL} 点血量;若已是满血,则改为让这个词的伤害翻 ${PRIMAL_RELEASE_DAMAGE_MULTIPLIER} 倍。`,
  },
  p2: {
    id: 'bloodbath',
    name: '浴血',
    character: 'p2',
    description: `接下来 ${BLOODBATH_WORDS} 个词的伤害与扣血都 ×${BLOODBATH_MULTIPLIER},但输入时限减少 25%。`,
  },
};

/**
 * 角色在界面上的称呼。跟着 assets/avatar/ 的槽位命名走(p1.png / p2.png),
 * 换立绘不必改这里。
 */
export const CHARACTER_LABEL: Record<CharacterId, string> = {
  p1: 'P1',
  p2: 'P2',
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

export interface WordQueue {
  next(): WordEntry;
}

/**
 * ★ 2026-08-06 修复:以前按 BATCH_SIZE(200)分批调用 buildSequence,每一批都是
 *   「把整个 pool 重新洗一次牌、只留最前面 200 个」——池子只要比 200 大,后面
 *   没被留下的部分就白洗了,下一批又是一次独立的全池重新抽样。结果是同一个词
 *   跨批次几乎没有"不重复"的保证,长会话(尤其无限模式,一局能抽几千个词)
 *   会明显感觉到某些词反复刷到。
 *
 *   现在换成一副真正跨批次持续的"牌堆":一次性洗好整个 pool,顺序发完才重新
 *   洗一次,保证同一个词至少要隔 pool.length 次才可能再出现。
 */
export function createWordQueue(pool: readonly WordEntry[], seed: string): WordQueue {
  if (pool.length === 0) {
    throw new Error('word pool is empty');
  }
  const rng = createRng(seed);
  let bag: WordEntry[] = [];

  function reshuffle(): void {
    bag = pool.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
  }

  return {
    next(): WordEntry {
      if (bag.length === 0) reshuffle();
      return bag.pop() as WordEntry;
    },
  };
}

/**
 * 从词池中选一个短打断词。长度按 typeText 计算，而非展示文本，确保带标点的
 * 词条仍以玩家实际需要输入的字符数为准；没有合格词时返回 null，绝不退回长词。
 *
 * ★ 传进来的必须是**没有经过 filterPoolByDifficulty 的完整池**。难度分布筛完
 *   之后,困难档最短的词是 4 字、地狱档最短 7 字 —— 拿地狱档的池来找 ≤4 字的
 *   打断词只会一个都找不到,泰坦之怒从此再也不会触发。打断词本来就该是短词,
 *   它的难度体现在读条窗口(DIFFICULTY_CAST_DURATION_MS)上,不在字数上。
 */
export function pickShortInterruptWord(pool: readonly WordEntry[], seed: string): WordEntry | null {
  const short = pool.filter((entry) => entry.typeText.length <= MAX_INTERRUPT_WORD_LENGTH);
  const hard = short.filter((entry) => entry.difficulty === 3);
  const mid = short.filter((entry) => entry.difficulty === 2);
  const src = hard.length > 0 ? hard : mid.length > 0 ? mid : short;
  return src.length > 0 ? buildSequence(src, 1, seed)[0] : null;
}
