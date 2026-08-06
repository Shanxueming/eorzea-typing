/**
 * 随机玩家 ID:形容词 + 名词 + #三位数字,例如「花容月貌的莫古力#417」。
 *
 * ★ 全随机,玩家不能自己输入 —— 需求明确要求。好处是不用做敏感词过滤,
 *   也不会有人抢名字;代价是抽到什么算什么,所以形容词表要写得好玩,
 *   抽到怪组合本身就是乐趣的一部分。
 *
 * ★ 名词从游戏自己的词库里取(具名角色、技能、地名、怪物),不另外维护一份 ——
 *   词库本来就是 FF14 的专有名词,拿来当 ID 天然对味。
 */
import { randomInt } from 'node:crypto';
import type { WordEntry } from '@eorzea/shared/types';

/**
 * 形容词表。刻意混了四字成语、书面语和大白话 —— 越不搭调,配上 FF14 的
 * 专有名词越好笑(「花容月貌的哥布林」「兢兢业业的泰坦」)。
 * 都以「的」结尾,直接拼名词就通顺。
 */
export const ADJECTIVES: readonly string[] = [
  '花容月貌的', '威风凛凛的', '兢兢业业的', '风尘仆仆的', '气宇轩昂的',
  '眉清目秀的', '灰头土脸的', '油光满面的', '容光焕发的', '衣冠楚楚的',
  '不修边幅的', '玉树临风的', '虎背熊腰的', '弱不禁风的', '膀大腰圆的',
  '手无缚鸡之力的', '力能扛鼎的', '健步如飞的', '慢条斯理的', '风风火火的',
  '雷厉风行的', '磨磨蹭蹭的', '气定神闲的', '手忙脚乱的', '眼疾手快的',
  '笨手笨脚的', '心灵手巧的', '五音不全的', '出口成章的', '沉默寡言的',
  '喋喋不休的', '能说会道的', '语无伦次的', '一本正经的', '嬉皮笑脸的',
  '愁眉苦脸的', '喜气洋洋的', '垂头丧气的', '斗志昂扬的', '无精打采的',
  '生龙活虎的', '睡眼惺忪的', '通宵达旦的', '早睡早起的', '废寝忘食的',
  '好吃懒做的', '勤勤恳恳的', '游手好闲的', '任劳任怨的', '偷奸耍滑的',
  '德高望重的', '默默无闻的', '深藏不露的', '锋芒毕露的', '大智若愚的',
  '不明觉厉的', '大器晚成的', '初出茅庐的', '身经百战的', '半途而废的',
  '坚持不懈的', '三心二意的', '专心致志的', '心不在焉的', '全神贯注的',
  '走火入魔的', '返璞归真的', '深谋远虑的', '鼠目寸光的', '高瞻远瞩的',
  '斤斤计较的', '大手大脚的', '省吃俭用的', '一掷千金的', '两袖清风的',
  '富可敌国的', '身无分文的', '腰缠万贯的', '囊中羞涩的', '挥金如土的',
  '见钱眼开的', '视金钱如粪土的', '锱铢必较的', '仗义疏财的', '爱财如命的',
  '胆大包天的', '胆小如鼠的', '临危不惧的', '闻风丧胆的', '有恃无恐的',
  '如履薄冰的', '横冲直撞的', '瞻前顾后的', '当机立断的', '优柔寡断的',
  '一往无前的', '知难而退的', '越挫越勇的', '一蹶不振的', '屡败屡战的',
  '常胜不败的', '逢赌必输的', '运气爆棚的', '倒霉透顶的', '时来运转的',
  '饥肠辘辘的', '酒足饭饱的', '挑食的', '来者不拒的', '无肉不欢的',
  '爱吃甜的', '嗜辣如命的', '滴酒不沾的', '千杯不醉的', '一杯就倒的',
  '路痴的', '认路很准的', '迷迷糊糊的', '精打细算的', '丢三落四的',
  '过目不忘的', '转头就忘的', '记仇的', '心大的', '想太多的',
  '社恐的', '自来熟的', '话痨的', '高冷的', '热心肠的',
];

/** 从词库里挑名词时的字数范围 —— 太长的名字念着累,太短的没辨识度 */
const NOUN_MIN_LENGTH = 2;
const NOUN_MAX_LENGTH = 5;

/**
 * 从词库条目里筛出适合当名字的名词。
 *
 * 只要具名角色、战斗技能、地名、怪物 —— 需求里点名的这四类。
 * characters 分类混了大量「爽朗的卫兵」这种路人 NPC,必须靠 named 过滤掉,
 * 否则会抽出「花容月貌的开朗的青年」这种叠字灾难。
 */
export function buildNounPool(entries: readonly WordEntry[]): string[] {
  const wanted = new Set(['characters', 'actions', 'places', 'monsters']);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    if (!wanted.has(e.category)) continue;
    if (e.category === 'characters' && e.named !== true) continue;
    if (!e.pure) continue; // 带数字/罗马数字的名字念不出来
    const n = e.typeText;
    if (n.length < NOUN_MIN_LENGTH || n.length > NOUN_MAX_LENGTH) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export interface GeneratedId {
  /** 展示用:花容月貌的莫古力#417 */
  displayId: string;
  /** 内部主键:去掉 # 与空白、转小写,登录时用它匹配 */
  id: string;
}

/** 把玩家输入的 ID 规范化成内部主键。大小写、多余空白、全角#都能容忍 */
export function normalizeId(input: string): string {
  return input.trim().replace(/\s+/g, '').replace(/＃/g, '#').toLowerCase();
}

/**
 * 生成一个随机 ID。
 *
 * 三位数字是**每个人都带**的(需求明确:不是同名去重序号),所以哪怕形容词和
 * 名词都撞了,后缀不同也是两个账号。调用方仍要检查 id 是否已存在并重试 ——
 * 生日悖论下 100 形容词 × 上千名词 × 1000 后缀依然可能撞。
 */
export function generateId(nouns: readonly string[]): GeneratedId {
  if (nouns.length === 0) throw new Error('名词池为空,无法生成 ID');
  const adj = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = nouns[randomInt(nouns.length)];
  const suffix = String(randomInt(100, 1000)); // 三位,不会出现 007 这种前导零
  const displayId = `${adj}${noun}#${suffix}`;
  return { displayId, id: normalizeId(displayId) };
}
