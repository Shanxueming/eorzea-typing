/**
 * 本地成绩记录。
 *
 * ★ 这一层是**将来接排行榜数据库的过渡形态**,不是最终方案。字段刻意按
 *   「一条可上传的成绩」来设计(而不是按界面需要的形状),等账号系统和数据库
 *   定下来之后,直接把同一个对象 POST 上去就行,不用再改调用方。
 *
 * 现在只存在浏览器 localStorage 里:换设备、清缓存都会丢,这是已知且可接受的
 * 过渡状态 —— 玩具阶段先让人看得到自己的最佳成绩。
 */
import type { CharacterId, Difficulty, GameMode, InputMode } from '@eorzea/shared/battle';

/** 一条成绩。字段是跨端契约的雏形,加字段容易、改字段难,想清楚再动。 */
export interface GameRecord {
  gameMode: GameMode;
  difficulty: Difficulty;
  /** ★ 排行榜必须按输入模式区分:组合输入允许反复退格,准确率天然低于逐字 */
  inputMode: InputMode;
  character: CharacterId;
  score: number;
  damage: number;
  wordsCompleted: number;
  accuracy: number;
  cpm: number;
  victory: boolean;
  /**
   * 客户端自查的可信度(0..100)与命中的 flag。
   * ⚠ **绝不能拿它当上榜依据** —— 它是在玩家自己的浏览器里算出来的,
   * 改个数字就能变成 100。真正的防线是上榜时把 attempts + seed 交给服务端
   * 重放一遍:服务端用同一个 seed 重建词序列,逐个核对 wordId/submitted,
   * 再重跑 checkAttempt 与 analyzeSession,最后重算得分与客户端声称的对比。
   * 这里存它只是为了在结算页给玩家一个即时提示。
   */
  trustScore: number;
  trustFlags: string[];
  /** 无限模式专属 */
  kills?: number;
  survivedMs?: number;
  maxCombo?: number;
  /**
   * 玩法变体标记,用来把「同样是标准+困难+组合、但其实不是一回事」的局分开存。
   *
   * ★ 没有它的话:每日挑战(固定 standard/hard/composed)会和快速开始选困难+
   *   组合掉进同一个桶,错题练习(自定义词池)也会掉进普通局的桶 —— 结算页的
   *   「★ 新纪录」和「此前最佳」就会拿两种根本不同的局互相比。
   * ★ 老记录没有这个字段(undefined),正好就代表「普通局」,不需要迁移。
   */
  variantKey?: 'daily' | 'mistake_practice';
  /** 记录产生的时刻(本机时钟,仅供展示排序) */
  recordedAt: number;
}

const STORAGE_KEY = 'eorzea:records:v1';
const MAX_RECORDS = 50;

function readAll(): GameRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as GameRecord[]) : [];
  } catch {
    // 存储被禁用(无痕/受限 WebView)或内容损坏时当作没有记录,不影响游戏
    return [];
  }
}

export function saveRecord(record: GameRecord): void {
  try {
    // 只留最近 MAX_RECORDS 条:localStorage 有配额,而且玩具阶段没人翻一百局以前的
    const next = [record, ...readAll()].slice(0, MAX_RECORDS);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 写不进去就算了,成绩展示不是核心链路
  }
}

/**
 * 取同一「玩法 + 难度 + 输入模式 + 玩法变体」下的历史最佳,用来在结算页告诉
 * 玩家有没有破纪录。四个维度都要匹配才算同一条赛道 —— 拿组合输入的成绩去比
 * 逐字的纪录没有意义,拿每日挑战(固定题目)去比快速开始(随机词)也一样。
 */
export function bestRecord(
  gameMode: GameMode,
  difficulty: Difficulty,
  inputMode: InputMode,
  variantKey?: GameRecord['variantKey'],
): GameRecord | null {
  const sameTrack = readAll().filter(
    (r) => r.gameMode === gameMode && r.difficulty === difficulty && r.inputMode === inputMode
      // 老记录没有 variantKey,undefined 正好等于「普通局」
      && (r.variantKey ?? undefined) === variantKey,
  );
  if (sameTrack.length === 0) return null;
  // 无限模式比「击杀数 → 存活时长」,标准模式比分数
  const better = (a: GameRecord, b: GameRecord) => {
    if (gameMode === 'endless') {
      if ((a.kills ?? 0) !== (b.kills ?? 0)) return (a.kills ?? 0) > (b.kills ?? 0) ? a : b;
      return (a.survivedMs ?? 0) >= (b.survivedMs ?? 0) ? a : b;
    }
    return a.score >= b.score ? a : b;
  };
  return sameTrack.reduce(better);
}
