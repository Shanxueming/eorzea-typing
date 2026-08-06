/**
 * 玩家账号的数据访问层。
 *
 * ★ 库里没有任何明文密码 —— 两套凭证都是加盐 scrypt 哈希。
 *   所以「查密码告诉玩家」这件事技术上做不到,忘记密码的正确流程是
 *   出示 root 密码核对身份、然后重置出一个新的(见 resetPassword)。
 */
import { getDb } from './database.js';
import {
  PLAYER_PASSWORD_LENGTH,
  ROOT_PASSWORD_LENGTH,
  generatePassword,
  hashSecret,
  normalizePassword,
  verifySecret,
} from '../auth/credentials.js';
import { generateId, normalizeId } from '../auth/idGenerator.js';

export interface PlayerRow {
  id: string;
  display_id: string;
  password_hash: string;
  password_salt: string;
  root_hash: string;
  root_salt: string;
  created_at: number;
  last_login_at: number | null;
  banned: number;
}

/** 注册成功时返回给玩家的三样东西。**这是明文唯一一次出现的地方** */
export interface IssuedAccount {
  id: string;
  displayId: string;
  password: string;
  rootPassword: string;
}

export function findPlayer(id: string): PlayerRow | null {
  const row = getDb().prepare('SELECT * FROM players WHERE id = ?').get(normalizeId(id));
  return (row as PlayerRow | undefined) ?? null;
}

/**
 * 注册一个新账号。
 *
 * ID 是全随机的,理论上会撞 —— 撞了就重抽,试够 MAX_TRIES 还撞说明名词池太小
 * 或者玩家数已经接近上限,这时候宁可报错也不要静默返回一个已存在的账号。
 */
export function createPlayer(nouns: readonly string[]): IssuedAccount {
  const db = getDb();
  const MAX_TRIES = 50;
  for (let i = 0; i < MAX_TRIES; i++) {
    const { id, displayId } = generateId(nouns);
    if (findPlayer(id)) continue;

    const password = generatePassword(PLAYER_PASSWORD_LENGTH);
    const rootPassword = generatePassword(ROOT_PASSWORD_LENGTH);
    const pw = hashSecret(password);
    const rt = hashSecret(rootPassword);

    db.prepare(`
      INSERT INTO players (id, display_id, password_hash, password_salt, root_hash, root_salt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, displayId, pw.hash, pw.salt, rt.hash, rt.salt, Date.now());

    return { id, displayId, password, rootPassword };
  }
  throw new Error('连续 50 次都抽到重复 ID,名词池可能太小');
}

export type LoginResult =
  | { ok: true; player: PlayerRow }
  | { ok: false; reason: 'not_found' | 'bad_password' | 'banned' };

export function login(rawId: string, rawPassword: string): LoginResult {
  const player = findPlayer(rawId);
  // 注意:即使账号不存在也走一遍 verifySecret 会更好(避免用响应时间探测账号是否存在),
  // 但这个游戏的 ID 是全随机发放的,枚举不出来,不值得为此多花一次 scrypt。
  if (!player) return { ok: false, reason: 'not_found' };
  if (player.banned) return { ok: false, reason: 'banned' };

  const ok = verifySecret(normalizePassword(rawPassword), {
    hash: player.password_hash,
    salt: player.password_salt,
  });
  if (!ok) return { ok: false, reason: 'bad_password' };

  getDb().prepare('UPDATE players SET last_login_at = ? WHERE id = ?').run(Date.now(), player.id);
  return { ok: true, player };
}

/** 用 root 密码核对身份。管理员帮玩家找回账号时走这条 */
export function verifyRoot(rawId: string, rawRootPassword: string): boolean {
  const player = findPlayer(rawId);
  if (!player) return false;
  return verifySecret(normalizePassword(rawRootPassword), {
    hash: player.root_hash,
    salt: player.root_salt,
  });
}

/**
 * 重置登录密码,返回新的明文(只此一次)。
 * root 密码不变 —— 它是账号的长期凭证,重置一次登录密码不该把它也换掉,
 * 否则玩家下次再忘密码就没有凭证可以出示了。
 */
export function resetPassword(id: string): string | null {
  const player = findPlayer(id);
  if (!player) return null;
  const password = generatePassword(PLAYER_PASSWORD_LENGTH);
  const pw = hashSecret(password);
  getDb()
    .prepare('UPDATE players SET password_hash = ?, password_salt = ? WHERE id = ?')
    .run(pw.hash, pw.salt, player.id);
  return password;
}

export function setBanned(id: string, banned: boolean): boolean {
  const player = findPlayer(id);
  if (!player) return false;
  getDb().prepare('UPDATE players SET banned = ? WHERE id = ?').run(banned ? 1 : 0, player.id);
  return true;
}

/** 管理员后台的账号列表。**不返回任何哈希字段** —— 后台也没有理由看到它们 */
export interface PlayerSummary {
  id: string;
  displayId: string;
  createdAt: number;
  lastLoginAt: number | null;
  banned: boolean;
  scoreCount: number;
}

export function listPlayers(keyword: string, limit = 50): PlayerSummary[] {
  const like = `%${normalizeId(keyword)}%`;
  const rows = getDb().prepare(`
    SELECT p.id, p.display_id, p.created_at, p.last_login_at, p.banned,
           (SELECT COUNT(*) FROM scores s WHERE s.player_id = p.id) AS score_count
    FROM players p
    WHERE (? = '%%') OR p.id LIKE ?
    ORDER BY p.created_at DESC
    LIMIT ?
  `).all(like, like, limit) as Array<{
    id: string; display_id: string; created_at: number;
    last_login_at: number | null; banned: number; score_count: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    displayId: r.display_id,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    banned: !!r.banned,
    scoreCount: r.score_count,
  }));
}

export function countPlayers(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number };
  return row.n;
}
