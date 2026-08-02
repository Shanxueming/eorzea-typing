/**
 * 全项目共享的数据结构。
 * 字段名与 data/wordbanks/*.json 严格一致,不要改动。
 */

export type WordCategory =
  | 'starter' | 'jobs' | 'actions' | 'craft_actions' | 'traits' | 'status'
  | 'characters' | 'monsters' | 'places' | 'duties' | 'quests' | 'items'
  | 'mounts' | 'minions' | 'emotes' | 'fates' | 'titles' | 'achievements'
  | 'races' | 'weather' | 'worlds' | 'music';

export interface WordEntry {
  id: string;
  /** 显示原文,可能含中点,如 "必杀剑·九天" */
  text: string;
  /** 判定文本,已剥离标点,如 "必杀剑九天"。★ 一切比对都用这个字段 */
  typeText: string;
  /** 拼音,空格分隔。用于提示,也用于拼音模式 */
  reading: string;
  category: WordCategory;
  /** 1 = ≤3字, 2 = 4-6字, 3 = ≥7字 */
  difficulty: 1 | 2 | 3;
  /** 是否纯汉字。false 表示含数字或罗马数字,IME 下难输入 */
  pure: boolean;
  /** 仅 characters 分类:是否为具名角色(非路人 NPC) */
  named?: boolean;
}

export interface WordBankFile {
  category: string;
  label: string;
  count: number;
  entries: WordEntry[];
}

/** 一次物理按键。中文 IME 下来自 keydown,不是上屏字符 */
export interface KeystrokeEvent {
  /** 相对本局开始的毫秒数 */
  t: number;
  code: string;
  /** KeyboardEvent.isTrusted */
  trusted: boolean;
  /** 是否处于 IME 合成态 */
  composing: boolean;
}

/** 一次「词完成」的提交 */
export interface WordAttempt {
  wordId: string;
  /** 词出现的时刻,相对本局 */
  startedAt: number;
  submittedAt: number;
  /** 玩家实际提交的文本 */
  submitted: string;
  keystrokes: KeystrokeEvent[];
  backspaces: number;
  /** IME 上屏次数 */
  compositionCommits: number;
  /** 本词期间页面失焦累计毫秒 */
  focusLostMs: number;
}

/** 输入模式。hanzi 走 IME,pinyin 是纯 ASCII 降级方案 */
export type TypingMode = 'hanzi' | 'pinyin';

export interface BattleConfig {
  seed: string;
  bossId: string;
  bossHp: number;
  durationMs: number;
  categories: WordCategory[];
  pureOnly: boolean;
  mode: TypingMode;
  /** Boss 读条间隔的随机区间 [min, max] */
  castIntervalMs: [number, number];
}

export type AvatarState = 'idle' | 'attack' | 'miss';

export interface PlayerResult {
  playerId: string;
  nick: string;
  score: number;
  damage: number;
  wordsCompleted: number;
  misses: number;
  /** 0..1 */
  accuracy: number;
  /** 字符每分钟 */
  cpm: number;
  interruptsSucceeded: number;
  interruptsFailed: number;
  /** 0..100 */
  trustScore: number;
  flags: string[];
}
