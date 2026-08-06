/**
 * 管理员会话。
 *
 * 两步认证:
 *   第一步 用户名 + 管理员密码
 *   第二步 二次口令(EORZEA_ADMIN_SECOND_PASSWORD)
 *          或者 TOTP 动态码(EORZEA_ADMIN_TOTP_SECRET,配了就优先用它)
 *
 * ★ 两种二次因子都支持,但强度不同,选哪个是运营方的决定:
 *   - **二次口令**:简单,不用装认证器。但它是**静态**的 —— 一旦两个密码
 *     同时泄露(比如你在同一个地方记了两串),二次认证就等于不存在。
 *   - **TOTP**:每 30 秒变一次,即使两个密码都被看到也进不去。
 *   配了 TOTP 密钥就自动切到 TOTP,不用改代码。
 *
 * ★ 必要的环境变量没配齐时,管理后台**整个关闭**(接口一律 404),
 *   而不是退化成「无密码可进」。默认安全,漏配顶多是后台用不了。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { currentCode, generateSecret, otpauthUrl, verifyTotp } from './totp.js';

const ADMIN_USER = process.env.EORZEA_ADMIN_USER ?? '';
const ADMIN_PASSWORD = process.env.EORZEA_ADMIN_PASSWORD ?? '';
const SECOND_PASSWORD = process.env.EORZEA_ADMIN_SECOND_PASSWORD ?? '';
const TOTP_SECRET = process.env.EORZEA_ADMIN_TOTP_SECRET ?? '';

/** 会话有效期。后台是低频操作,两小时够用 */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** 失败后的强制等待。静态口令没有时效性,更需要靠节流拖慢暴力猜解 */
const FAIL_BACKOFF_MS = 3000;

interface Session {
  token: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
let lastFailAt = 0;

/** 二次因子用哪种。TOTP 优先 —— 它更强,配了就没道理还用静态口令 */
export type SecondFactor = 'totp' | 'password' | 'none';

export function secondFactorKind(): SecondFactor {
  if (TOTP_SECRET) return 'totp';
  if (SECOND_PASSWORD) return 'password';
  return 'none';
}

export function isAdminEnabled(): boolean {
  return ADMIN_USER.length > 0 && ADMIN_PASSWORD.length > 0 && secondFactorKind() !== 'none';
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export type AdminLoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; reason: 'disabled' | 'bad_credentials' | 'bad_second' | 'throttled' };

/**
 * @param second 二次口令或 TOTP 六位码,取决于 secondFactorKind()
 *
 * ★ 用户名和密码错误返回同一个 reason(`bad_credentials`)——
 *   分开报会告诉攻击者「用户名猜对了」。
 */
export function adminLogin(user: string, password: string, second: string): AdminLoginResult {
  if (!isAdminEnabled()) return { ok: false, reason: 'disabled' };
  if (Date.now() - lastFailAt < FAIL_BACKOFF_MS) return { ok: false, reason: 'throttled' };

  const userOk = safeEqual(user, ADMIN_USER);
  const passOk = safeEqual(password, ADMIN_PASSWORD);
  // 两个都算完再判,不提前 return —— 免得响应时间泄露是哪一项错了
  if (!userOk || !passOk) {
    lastFailAt = Date.now();
    return { ok: false, reason: 'bad_credentials' };
  }

  const secondOk = secondFactorKind() === 'totp'
    ? verifyTotp(TOTP_SECRET, second)
    : safeEqual(second, SECOND_PASSWORD);
  if (!secondOk) {
    lastFailAt = Date.now();
    return { ok: false, reason: 'bad_second' };
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { token, expiresAt });
  return { ok: true, token, expiresAt };
}

export function verifyAdminToken(token: string | undefined): boolean {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function adminLogout(token: string | undefined): void {
  if (token) sessions.delete(token);
}

/** 启动时的引导信息。密钥只走服务端日志,不经过网络 */
export function printAdminSetup(): void {
  if (isAdminEnabled()) {
    const kind = secondFactorKind() === 'totp' ? 'TOTP 动态码' : '二次口令';
    // eslint-disable-next-line no-console
    console.log(`[admin] 管理后台已启用(用户名 + 密码 + ${kind})`);
    return;
  }
  if (!ADMIN_USER && !ADMIN_PASSWORD && secondFactorKind() === 'none') {
    // eslint-disable-next-line no-console
    console.log('[admin] 管理后台未启用:未配置 EORZEA_ADMIN_* 环境变量');
    return;
  }
  const secret = TOTP_SECRET || generateSecret();
  // eslint-disable-next-line no-console
  console.log(
    '\n[admin] 管理后台配置不完整,当前关闭。补齐后重启:\n' +
    '  EORZEA_ADMIN_USER=<用户名>\n' +
    '  EORZEA_ADMIN_PASSWORD=<第一道密码>\n' +
    '  二次因子二选一:\n' +
    '    EORZEA_ADMIN_SECOND_PASSWORD=<第二道口令>   (简单,静态)\n' +
    `    EORZEA_ADMIN_TOTP_SECRET=${secret}  (更强,动态)\n` +
    `      扫这个绑定认证器(当前码 ${currentCode(secret)}):\n` +
    `      ${otpauthUrl(secret)}\n`,
  );
}
