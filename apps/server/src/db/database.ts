/**
 * SQLite 连接与建表。
 *
 * ★ 用 Node 24 内置的 `node:sqlite`,不引任何第三方驱动或 ORM ——
 *   AGENTS.md 的依赖白名单里没有它们,而这个项目要存的东西也就两张表,
 *   手写 SQL 比引一层抽象更清楚。
 *
 * ★ 数据库文件放在 EORZEA_DATA_DIR(容器里是 /data,由 bind mount 挂到宿主机)。
 *   **千万别把它放进镜像里的应用目录** —— 每次重新部署镜像都会重建,数据就没了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 数据目录。默认放在仓库根的 .data/,方便本地开发;线上由环境变量指到挂载卷 */
export const DATA_DIR = process.env.EORZEA_DATA_DIR
  ?? path.join(process.cwd(), '.data');

let db: DatabaseSync | null = null;

/**
 * 建表语句。全部 IF NOT EXISTS,所以这个函数可以重复执行 ——
 * 每次进程启动都会跑一遍,相当于最简单的「迁移」。
 * 以后要加字段,追加一条 ALTER TABLE 并自己判断是否已存在(见 addColumnIfMissing)。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  -- 内部主键,小写无空格,登录时用它匹配(玩家输入的展示 ID 会被规范化成这个)
  id            TEXT PRIMARY KEY,
  -- 展示用的完整 ID,例如「花容月貌的莫古力#417」
  display_id    TEXT NOT NULL,
  -- 玩家日常登录用的密码
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  -- root 密码:玩家自己收好,忘记登录密码时出示给管理员核对身份用。
  -- 游戏里没有任何地方会让玩家输入它。
  root_hash     TEXT NOT NULL,
  root_salt     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  -- 管理员封禁:封了就不能登录、成绩也不上榜
  banned        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id    TEXT NOT NULL REFERENCES players(id),
  game_mode    TEXT NOT NULL,
  difficulty   TEXT NOT NULL,
  input_mode   TEXT NOT NULL,
  character    TEXT NOT NULL,
  -- 标准模式:讨伐耗时(毫秒,越小越好)。无限模式为 NULL
  clear_ms     INTEGER,
  -- 无限模式:击杀数与存活时长。标准模式为 NULL
  kills        INTEGER,
  survived_ms  INTEGER,
  score        INTEGER NOT NULL,
  accuracy     REAL NOT NULL,
  cpm          INTEGER NOT NULL,
  words        INTEGER NOT NULL,
  -- 服务端重放核算出来的可信度,不是客户端报上来的那个
  trust_score  INTEGER NOT NULL,
  flags        TEXT NOT NULL DEFAULT '[]',
  -- 管理员下榜:不删记录,只是不再展示
  hidden       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

-- 榜单查询的形状固定:先按赛道过滤,再排序取前 N
CREATE INDEX IF NOT EXISTS idx_scores_track
  ON scores (game_mode, difficulty, input_mode, hidden);
CREATE INDEX IF NOT EXISTS idx_scores_player ON scores (player_id);

-- 联机团队成绩。一条记录代表"这一对搭档"的最好成绩,不是每人一条——
-- player_a_id/player_b_id 写入前按字典序排过序,同一对人不管谁创房、
-- 谁是 A 谁是 B,都会命中同一条记录,不会因为顺序不同而各记一份。
CREATE TABLE IF NOT EXISTS coop_scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_a_id   TEXT NOT NULL REFERENCES players(id),
  player_a_name TEXT NOT NULL,
  player_b_id   TEXT NOT NULL REFERENCES players(id),
  player_b_name TEXT NOT NULL,
  game_mode     TEXT NOT NULL,
  difficulty    TEXT NOT NULL,
  input_mode    TEXT NOT NULL,
  -- 标准模式:讨伐耗时(毫秒)。无限模式为 NULL
  clear_ms      INTEGER,
  -- 无限模式:击杀数与存活时长。标准模式为 NULL
  kills         INTEGER,
  survived_ms   INTEGER,
  -- 两人 PlayerResult.score 之和
  score         INTEGER NOT NULL,
  -- 两人里较低的那个 trustScore(取短板),flags 是两人的并集
  trust_score   INTEGER NOT NULL,
  flags         TEXT NOT NULL DEFAULT '[]',
  hidden        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coop_scores_track
  ON coop_scores (game_mode, difficulty, input_mode, hidden);
CREATE INDEX IF NOT EXISTS idx_coop_scores_pair ON coop_scores (player_a_id, player_b_id);

-- 开局埋点,给管理后台的用量看板用:每开一局(单机/联机)客户端都会报一条。
-- device_id 是纯匿名的本机随机串(存在 localStorage,不绑账号),只用来数
-- "今天有多少台设备玩过"——联机一局两个人各报一条,所以按 device_id 去重
-- 才是"人数",按 match_key 去重才是"局数"(match_key 是房间码,单机为 NULL,
-- 单机每条都算一局不用去重)。
CREATE TABLE IF NOT EXISTS game_starts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  mode        TEXT NOT NULL,
  game_mode   TEXT NOT NULL,
  difficulty  TEXT NOT NULL,
  match_key   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_starts_day ON game_starts (created_at);
`;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'eorzea.db');
  db = new DatabaseSync(file);
  // WAL:读写并发下不会互相阻塞。这个游戏读多写少,收益明显
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // eslint-disable-next-line no-console
  console.log(`[db] SQLite 已就绪:${file}`);
  return db;
}

/** 测试用:关掉连接并让下次 getDb 重新打开 */
export function closeDb(): void {
  db?.close();
  db = null;
}
