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
  -- input_mode 是后加的列,见下面 addColumnIfMissing——老数据这一列是 NULL,
  -- 查询时会自然被过滤掉,不影响"按赛道统计"的准确性,只是老数据不参与罢了。
);

CREATE INDEX IF NOT EXISTS idx_game_starts_day ON game_starts (created_at);

-- ★ 2026-08-10:登录玩家的每一局原始存档,不管有没有点"上传成绩到排行榜"。
--   排行榜(scores 表)只留「这一轮最好的那条」,没点上传、或者点了但没打过
--   历史最佳,原始材料就彻底没地方找了——这张表就是补这个口子:只要登录着,
--   打完一局(不管输赢、要不要上榜)就整局原样存一份,7 天后自动清掉
--   (见 db/playSessions.ts 的 cleanupOldPlaySessions)。纯粹是"万一榜单
--   出问题/玩家想找回来"的兜底存档,不是排行榜数据源,不参与任何排名/统计。
CREATE TABLE IF NOT EXISTS play_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     TEXT NOT NULL REFERENCES players(id),
  game_mode     TEXT NOT NULL,
  difficulty    TEXT NOT NULL,
  input_mode    TEXT NOT NULL,
  character     TEXT NOT NULL,
  mode          TEXT NOT NULL,
  categories    TEXT NOT NULL,
  pure_only     INTEGER NOT NULL,
  seed          TEXT NOT NULL,
  elapsed_ms    INTEGER NOT NULL,
  victory       INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  claimed_score INTEGER NOT NULL,
  claimed_clear_ms INTEGER,
  claimed_kills INTEGER,
  claimed_survived_ms INTEGER,
  -- 原始逐词遥测(WordAttempt[] 的 JSON),需要的话可以拿去重放核算——
  -- 这是唯一留着"能重建这一局"的地方,scores 表只存重算之后的结论。
  attempts      TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_play_sessions_player ON play_sessions (player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_play_sessions_created ON play_sessions (created_at);

-- ★ 2026-08-11:每日挑战。单独一张表而不是往 scores 里塞一个 game_mode='daily':
--   1) scores 的轮次是 7 天,每日挑战是 1 天,period 语义根本不同;
--   2) GameMode 这个类型是联机协议也在用的,给它加成员会波及一整条链路。
--   分开之后两边互不干扰,每日挑战的规则以后想怎么改都不会碰到正式榜。
--   date_key 是北京时区的自然日("2026-08-11"),既是分组键也是 seed 的一部分。
CREATE TABLE IF NOT EXISTS daily_scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id   TEXT NOT NULL REFERENCES players(id),
  date_key    TEXT NOT NULL,
  character   TEXT NOT NULL,
  -- 讨伐耗时(毫秒,越小越好)。每日挑战只收通关成绩,所以这一列不会是 NULL
  clear_ms    INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  accuracy    REAL NOT NULL,
  cpm         INTEGER NOT NULL,
  words       INTEGER NOT NULL,
  trust_score INTEGER NOT NULL,
  flags       TEXT NOT NULL DEFAULT '[]',
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
-- 每人每天只留最好的一条,靠这个唯一索引兜底(应用层也会先查再更新)
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_scores_player_day
  ON daily_scores (player_id, date_key);
CREATE INDEX IF NOT EXISTS idx_daily_scores_board ON daily_scores (date_key, hidden, clear_ms);
`;

/**
 * 给已存在的表补一列,幂等——重复执行不报错。用 PRAGMA table_info 自己查有没有,
 * 而不是 try/catch "ALTER TABLE ADD COLUMN 已存在"的报错,那种写法在不同 SQLite
 * 版本上报错文案不一定一致,容易误吞别的错误。
 */
function addColumnIfMissing(database: DatabaseSync, table: string, column: string, definition: string): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'eorzea.db');
  db = new DatabaseSync(file);
  // WAL:读写并发下不会互相阻塞。这个游戏读多写少,收益明显
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // ★ 2026-08-08:game_starts 补 input_mode——赛道 = 玩法+难度+输入模式,
  //   百分位统计要按赛道精确统计"这条赛道打了多少人",少这一列就只能按
  //   玩法+难度粗略估算,组合输入和逐字输入会被混在一起数。
  addColumnIfMissing(db, 'game_starts', 'input_mode', 'TEXT');
  // eslint-disable-next-line no-console
  console.log(`[db] SQLite 已就绪:${file}`);
  return db;
}

/** 测试用:关掉连接并让下次 getDb 重新打开 */
export function closeDb(): void {
  db?.close();
  db = null;
}
