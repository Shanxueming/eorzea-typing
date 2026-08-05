/**
 * 开发/测试开关。全部默认关闭,只能靠环境变量显式打开。
 *
 * ★★★ 这些开关会削弱反作弊,**绝对不要在对外的正式服上打开**。
 *     打开时服务端启动会打印一行醒目警告,就是为了让人一眼看见自己开着它。
 */

/**
 * 允许合成输入事件(`isTrusted === false`)通过反作弊的硬校验。
 *
 * 为什么需要它:自动化测试(浏览器脚本、E2E)发出的键盘事件 `isTrusted` 恒为
 * false,会被 `checkAttempt` 打上 `untrusted_event` 直接判负 —— 这正是反作弊
 * 该做的事,但也让「用脚本跑一遍联机对局」变得不可能。开这个开关只放行这一条,
 * 时间线倒流、时钟偏移、粘贴检测等其余校验一条不少,统计层(analyzeSession)
 * 也照常跑,所以拿它刷出来的成绩依然会是低可信度。
 *
 * 用法:`EORZEA_ALLOW_SYNTHETIC_INPUT=1 pnpm start`
 */
export const ALLOW_SYNTHETIC_INPUT = process.env.EORZEA_ALLOW_SYNTHETIC_INPUT === '1';

/** 有任何一个测试开关打开时,在启动日志里喊一嗓子 */
export function warnIfDevFlagsEnabled(): void {
  if (!ALLOW_SYNTHETIC_INPUT) return;
  // eslint-disable-next-line no-console
  console.warn(
    '\n' +
    '  ⚠⚠⚠  测试模式:EORZEA_ALLOW_SYNTHETIC_INPUT=1\n' +
    '        合成输入事件不再被反作弊拦截。这是给自动化测试用的,\n' +
    '        对外服务请务必去掉这个环境变量再启动。\n',
  );
}
