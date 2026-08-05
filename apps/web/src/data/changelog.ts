/**
 * 更新说明。
 *
 * ★ 加新版本时:往 CHANGELOG 顶部插一条,并把 LATEST_VERSION 改成它的 version。
 *   玩家第一次看到某个版本会自动弹一次,点「我知道了」之后记进 localStorage,
 *   下次不再自动弹;想再看从主菜单的「更新说明」进。
 *
 * ★ 写给玩家看,不是写给开发者看:只讲「能玩到什么」,不讲修了哪些 bug、
 *   也不堆数值表。想看数值口径去 AGENTS.md 的难度表。
 */

/** 一个条目:可选的小标题 + 正文。正文里的换行会原样保留 */
export interface ChangelogItem {
  name?: string;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  /** 顶部那段地址/说明,没有就不显示 */
  lead?: string;
  sections: { title: string; items: ChangelogItem[] }[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '2026.08.05',
    date: '2026-08-05',
    lead: '游戏地址：http://47.103.120.8:8799\n（记得带上后面的 :8799，手机电脑都能开）',
    sections: [
      {
        title: '新玩法',
        items: [
          {
            name: '无限模式',
            text: '没有时间限制，泰坦打倒一只立刻刷下一只，\n一只比一只血厚，击杀回血，撑到倒下为止。\n比的是你能扛到第几只。',
          },
          {
            name: '组合输入（现在是默认）',
            text: '打错不再立刻判负了。输入框变红就是打错了，\n退格改到变绿就算过。\n想要以前那种「错一个字直接结算」的手感，\n在菜单里选「逐字输入」。',
          },
          {
            name: '出战角色',
            text: 'P1 —— 原初的解放\n　跳过当前这个词，连击不断。遇到不会打的词可以用。\nP2 —— 浴血\n　接下来三个词伤害翻 1.5 倍，但扣血也翻 1.5 倍，\n　而且输入时间少四分之一。搏一搏。\n技能冷却 90 秒，一局大概能开两次。\n按 Tab 键开技能，也可以直接点按钮。',
          },
        ],
      },
      {
        title: '泰坦的新招',
        items: [
          {
            name: '三连桶',
            text: '你会随机站在跑道最左边或最右边，\n打对应方向的词左右挪动，\n躲到中间的石头后面才安全。',
          },
          {
            name: '三穿一',
            text: '三个词标着 1、2、3，必须按顺序打完。\n打错顺序只作废那一个，计时不停。',
          },
          { name: '泰坦之怒', text: '改成了保底机制。' },
        ],
      },
      {
        title: '四档难度终于不一样了',
        items: [
          {
            text: '以前普通和困难其实只差一点时间，基本没感觉。\n现在从出什么词到扣多少血全都不同：',
          },
          { text: '· 泰坦血量：困难 +30%，地狱翻倍' },
          { text: '· 简单难度不会触发任何机制，纯粹练手用' },
          { text: '· 地狱难度只能用逐字输入 —— 那一档的规矩\n　就是打错一个字立刻判负' },
        ],
      },
      {
        title: '手机能玩了',
        items: [
          {
            text: '不再劝退移动端，手机上可以正常玩单人模式。\n联机还是得用电脑（两个人对着房间码等，小屏幕太难受）。',
          },
        ],
      },
      {
        title: '联机怎么玩',
        items: [
          {
            text: '一个人点「联机对战」→「创建房间」，拿到 6 位房间码，\n另一个人输同样的码点「加入房间」。\n一间房两个人，共用一条血条，一起打泰坦。',
          },
        ],
      },
    ],
  },
];

export const LATEST_VERSION = CHANGELOG[0].version;

const STORAGE_KEY = 'eorzea:changelog-seen';

/** 玩家有没有看过最新这版更新说明 */
export function hasSeenLatest(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === LATEST_VERSION;
  } catch {
    // 无痕模式读不到 —— 当作没看过,大不了每次都弹一下
    return false;
  }
}

export function markLatestSeen(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, LATEST_VERSION);
  } catch {
    // 写不进去就算了,不影响玩
  }
}
