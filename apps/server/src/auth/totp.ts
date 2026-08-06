/**
 * TOTP(基于时间的一次性口令,RFC 6238)—— 管理员的二次认证。
 *
 * ★ 手写而不是引 otplib:算法本身就是「HMAC-SHA1 + 取模」十几行,
 *   而 node:crypto 已经内置 HMAC。引一个库来做这点事不值得,
 *   项目的依赖白名单里也没有它。
 *
 * 兼容 Google Authenticator / 微软 Authenticator / 1Password 等所有标准实现:
 * SHA-1、6 位、30 秒步长,就是它们的默认参数。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGITS = 6;
const STEP_SECONDS = 30;
/** 允许前后各一个时间窗:手机和服务器的时钟差个十几秒是常事 */
const WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`不是合法的 base32 字符: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 算出某个时间步的 6 位码 */
function codeForCounter(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  // 计数器是 64 位大端。JS 的位运算只有 32 位,所以高低两半分开写
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac('sha1', key).update(buf).digest();
  // 动态截断:用最后一个字节的低 4 位决定从哪儿取 4 个字节
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * 校验一个 6 位码。
 * 前后各放宽一个 30 秒窗口,并且用 timingSafeEqual 比较 ——
 * 逐字符比较会通过响应时间泄露「前几位猜对了」。
 */
export function verifyTotp(secret: string, token: string, now = Date.now()): boolean {
  const clean = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let w = -WINDOW; w <= WINDOW; w++) {
    const expected = codeForCounter(secret, counter + w);
    const a = Buffer.from(expected);
    const b = Buffer.from(clean);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * 生成 otpauth:// URL —— 把它做成二维码用认证器扫一下就绑定好了。
 * 首次配置时打印在服务端日志里,不走网络,避免密钥被中间人看到。
 */
export function otpauthUrl(secret: string, account = 'admin', issuer = '艾欧泽亚打字修行'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 当前这一刻的码。只在服务端本地打印用,不通过 HTTP 暴露 */
export function currentCode(secret: string, now = Date.now()): string {
  return codeForCounter(secret, Math.floor(now / 1000 / STEP_SECONDS));
}
