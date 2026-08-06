/**
 * 凭证生成与校验。
 *
 * ★ 密码一律**加盐 scrypt 哈希**后入库,数据库里没有任何明文。
 *   这意味着管理员也查不到玩家的原密码 —— 玩家忘记密码时的正确流程是
 *   「出示 root 密码 → 管理员核对 → 重置出一个新密码」,而不是「把原密码查给他」。
 *   这一点比「方便」重要:库一旦泄露,明文密码会连带影响玩家在别处复用的密码。
 *
 * ★ scrypt 与 timingSafeEqual 都来自 node:crypto,零依赖。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 密码字符集:去掉了 0/O/1/I/l 这些看着像的字符。
 * 玩家要照着屏幕手抄或者念给别人听,少一个歧义就少一次「登不上」的求助。
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 玩家登录密码:12 位,每 4 位一组显示,好抄 */
export const PLAYER_PASSWORD_LENGTH = 12;
/** root 密码:16 位。它是账号的最后凭证,给足强度 */
export const ROOT_PASSWORD_LENGTH = 16;

const SCRYPT_KEYLEN = 32;

export function generatePassword(length: number): string {
  // randomBytes 而不是 Math.random:后者不是密码学安全的随机源
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 分组显示,例如 A1B2C3D4E5F6 -> A1B2-C3D4-E5F6。只影响展示,存的还是原串 */
export function formatForDisplay(password: string, groupSize = 4): string {
  const groups: string[] = [];
  for (let i = 0; i < password.length; i += groupSize) {
    groups.push(password.slice(i, i + groupSize));
  }
  return groups.join('-');
}

/** 玩家可能把带横线的形式贴回来,登录前统一去掉分隔符再比对 */
export function normalizePassword(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase();
}

export interface HashedSecret {
  hash: string;
  salt: string;
}

export function hashSecret(secret: string): HashedSecret {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(secret, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

/**
 * 校验。用 timingSafeEqual 而不是 === ——
 * 字符串比较会在第一个不同的字节上提前返回,响应时间因此泄露「猜对了几位」。
 */
export function verifySecret(secret: string, stored: HashedSecret): boolean {
  try {
    const actual = scryptSync(secret, stored.salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(stored.hash, 'hex');
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
