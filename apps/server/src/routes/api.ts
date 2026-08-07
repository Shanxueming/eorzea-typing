/**
 * 账号、排行榜与管理后台的 HTTP 接口。
 *
 * ★ 三条不能忘的规矩:
 *   1. **明文凭证只在注册/重置那一次响应里出现**,之后任何接口都查不到。
 *   2. **上榜必须过 replayAndScore**,客户端报的分一律不采信。
 *   3. 管理接口全部要 Bearer 令牌,且后台没配环境变量时整体 404。
 */
import type { FastifyInstance } from 'fastify';
import type { WordEntry } from '@eorzea/shared/types';
import { RANKED_DIFFICULTIES, getLeaderboard, listScoresForAdmin, setScoreHidden, submitScore } from '../db/scores.js';
import { getCoopLeaderboard, listCoopScoresForAdmin, setCoopScoreHidden } from '../db/coopScores.js';
import {
  countPlayers, createPlayer, findPlayer, listPlayers, login,
  resetPassword, setBanned, verifyRoot,
} from '../db/players.js';
import { resolveInputMode } from '@eorzea/shared/battle';
import { formatForDisplay } from '../auth/credentials.js';
import { buildNounPool } from '../auth/idGenerator.js';
import { adminLogin, adminLogout, isAdminEnabled, secondFactorKind, verifyAdminToken } from '../auth/adminSession.js';
import { replayAndScore, type ReplayPayload } from '../scoreReplay.js';
import { loadBank } from '../rooms/wordbankStore.js';

/** 名词池只在首次用到时构建一次 —— 每次注册都读一遍词库太浪费 */
let nounPool: string[] | null = null;
async function getNounPool(): Promise<string[]> {
  if (nounPool) return nounPool;
  const starter = await loadBank('starter');
  nounPool = buildNounPool(starter.entries as WordEntry[]);
  // eslint-disable-next-line no-console
  console.log(`[account] 名词池 ${nounPool.length} 条`);
  return nounPool;
}

function bearer(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return undefined;
  return raw.startsWith('Bearer ') ? raw.slice(7) : undefined;
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // ─────────────────────── 账号 ───────────────────────

  /**
   * 申请账号。返回的三样东西**只此一次**,页面必须让玩家自己存好。
   * 不需要任何输入 —— ID 与两个密码都是服务端随机生成的。
   */
  app.post('/api/account/register', async () => {
    const nouns = await getNounPool();
    const account = createPlayer(nouns);
    return {
      ok: true,
      displayId: account.displayId,
      // 分组显示只是为了好抄,登录时带不带横线都认
      password: formatForDisplay(account.password),
      rootPassword: formatForDisplay(account.rootPassword, 4),
    };
  });

  app.post('/api/account/login', async (req, reply) => {
    const body = req.body as { id?: unknown; password?: unknown } | undefined;
    if (typeof body?.id !== 'string' || typeof body?.password !== 'string') {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    const result = login(body.id, body.password);
    if (!result.ok) return reply.code(401).send({ ok: false, error: result.reason });
    return { ok: true, id: result.player.id, displayId: result.player.display_id };
  });

  // ─────────────────────── 排行榜 ───────────────────────

  app.get('/api/leaderboard', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const gameMode = q.gameMode === 'endless' ? 'endless' : 'standard';
    const difficulty = q.difficulty === 'hell' ? 'hell' : 'hard';
    const requested = q.inputMode === 'sequential' ? 'sequential' : 'composed';
    if (!RANKED_DIFFICULTIES.includes(difficulty)) {
      return reply.code(400).send({ ok: false, error: 'unranked_difficulty' });
    }
    // ★ 按难度收敛:地狱强制逐字,「地狱 + 组合输入」这条赛道不存在。
    //   查询侧不收敛的话,请求它只会得到一个空榜,让人以为「没人上榜」。
    //   把实际用的赛道回给前端,免得界面标签和内容对不上。
    const inputMode = resolveInputMode(difficulty, requested);
    return { ok: true, inputMode, rows: getLeaderboard(gameMode, difficulty, inputMode, 50) };
  });

  /**
   * 联机团队榜。查询参数与单机榜同名同义,只是查的是 coop_scores 表——
   * 一条记录是"一对搭档",不是一个人,提交在 Room.attemptCoopLeaderboardSubmit
   * 里完成,服务端权威分数,不走 replayAndScore。
   */
  app.get('/api/leaderboard/coop', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const gameMode = q.gameMode === 'endless' ? 'endless' : 'standard';
    const difficulty = q.difficulty === 'hell' ? 'hell' : 'hard';
    const requested = q.inputMode === 'sequential' ? 'sequential' : 'composed';
    if (!RANKED_DIFFICULTIES.includes(difficulty)) {
      return reply.code(400).send({ ok: false, error: 'unranked_difficulty' });
    }
    const inputMode = resolveInputMode(difficulty, requested);
    return { ok: true, inputMode, rows: getCoopLeaderboard(gameMode, difficulty, inputMode, 50) };
  });

  /**
   * 提交成绩。
   *
   * ★ 客户端交的是**原始材料**(seed + 配置 + 逐词遥测),不是结论。
   *   服务端重放一遍算出自己的分数并核对可信度,只有过了才写库。
   */
  app.post('/api/score/submit', async (req, reply) => {
    const body = req.body as (ReplayPayload & { playerId?: unknown; password?: unknown }) | undefined;
    if (!body || typeof body.playerId !== 'string' || typeof body.password !== 'string') {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    // 提交成绩要重新验一次身份 —— 不能只凭前端说自己是谁
    const auth = login(body.playerId, body.password);
    if (!auth.ok) return reply.code(401).send({ ok: false, error: auth.reason });

    if (!RANKED_DIFFICULTIES.includes(body.difficulty)) {
      return reply.code(400).send({ ok: false, error: 'unranked_difficulty' });
    }
    // 标准模式只收通关的(需求 Q22);无限模式没有「通关」概念,一律收
    if (body.gameMode === 'standard' && typeof body.claimed?.clearMs !== 'number') {
      return reply.code(400).send({ ok: false, error: 'not_cleared' });
    }

    const verdict = await replayAndScore(body);
    if (!verdict.ok) {
      return reply.code(422).send({ ok: false, error: verdict.reason, flags: verdict.flags });
    }

    const result = submitScore({
      playerId: auth.player.id,
      gameMode: body.gameMode,
      difficulty: body.difficulty,
      inputMode: body.inputMode,
      character: body.character,
      clearMs: body.gameMode === 'standard' ? body.claimed.clearMs : undefined,
      kills: body.gameMode === 'endless' ? body.claimed.kills : undefined,
      survivedMs: body.gameMode === 'endless' ? body.claimed.survivedMs : undefined,
      // 全部用服务端重算的值
      score: verdict.score,
      accuracy: verdict.accuracy,
      cpm: verdict.cpm,
      words: verdict.words,
      trustScore: verdict.trustScore,
      flags: verdict.flags,
    });
    return { ok: true, status: result.status, trustScore: verdict.trustScore, flags: verdict.flags };
  });

  // ─────────────────────── 管理后台 ───────────────────────

  /** 后台没配环境变量时,所有 /api/admin/* 一律 404 —— 连存在与否都不暴露 */
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/admin')) return;
    if (!isAdminEnabled()) return reply.code(404).send({ ok: false, error: 'not_found' });
    // 登录接口与二次因子类型查询不需要令牌 —— 不然没法登录
    if (req.url === '/api/admin/login' || req.url === '/api/admin/factor') return;
    if (!verifyAdminToken(bearer(req as never))) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  });

  /** 让登录页知道第二栏该提示「二次口令」还是「动态验证码」 */
  app.get('/api/admin/factor', async () => ({ ok: true, kind: secondFactorKind() }));

  app.post('/api/admin/login', async (req, reply) => {
    const body = req.body as { user?: unknown; password?: unknown; second?: unknown } | undefined;
    if (typeof body?.user !== 'string' || typeof body?.password !== 'string'
        || typeof body?.second !== 'string') {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    const r = adminLogin(body.user, body.password, body.second);
    if (!r.ok) return reply.code(401).send({ ok: false, error: r.reason });
    return { ok: true, token: r.token, expiresAt: r.expiresAt };
  });

  app.post('/api/admin/logout', async (req) => {
    adminLogout(bearer(req as never));
    return { ok: true };
  });

  app.get('/api/admin/players', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { ok: true, total: countPlayers(), rows: listPlayers(q.keyword ?? '', 50) };
  });

  /**
   * 用 root 密码核对玩家身份。
   * 玩家忘了登录密码来找你时:让他把 root 密码发你,在这里验一下是不是本人。
   */
  app.post('/api/admin/verify-root', async (req, reply) => {
    const body = req.body as { id?: unknown; rootPassword?: unknown } | undefined;
    if (typeof body?.id !== 'string' || typeof body?.rootPassword !== 'string') {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    const player = findPlayer(body.id);
    if (!player) return reply.code(404).send({ ok: false, error: 'not_found' });
    return { ok: true, matched: verifyRoot(body.id, body.rootPassword), displayId: player.display_id };
  });

  /**
   * 重置玩家的登录密码,返回新的明文(只此一次)。
   *
   * ★ 库里存的是加盐哈希,**原密码谁也查不出来**,所以「找回」只能是「换一个」。
   *   这不是偷懒:明文存储一旦泄露,会连累玩家在别处复用的密码。
   */
  app.post('/api/admin/reset-password', async (req, reply) => {
    const body = req.body as { id?: unknown } | undefined;
    if (typeof body?.id !== 'string') return reply.code(400).send({ ok: false, error: 'bad_request' });
    const pw = resetPassword(body.id);
    if (!pw) return reply.code(404).send({ ok: false, error: 'not_found' });
    return { ok: true, password: formatForDisplay(pw) };
  });

  app.post('/api/admin/ban', async (req, reply) => {
    const body = req.body as { id?: unknown; banned?: unknown } | undefined;
    if (typeof body?.id !== 'string' || typeof body?.banned !== 'boolean') {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    if (!setBanned(body.id, body.banned)) {
      return reply.code(404).send({ ok: false, error: 'not_found' });
    }
    return { ok: true };
  });

  app.get('/api/admin/scores', async () => ({ ok: true, rows: listScoresForAdmin(100) }));

  /** 下榜/恢复。只翻标记不删记录,误操作可以还原 */
  app.post('/api/admin/score-visibility', async (req, reply) => {
    const body = req.body as { scoreId?: unknown; hidden?: unknown } | undefined;
    if (typeof body?.scoreId !== 'number' || typeof body?.hidden !== 'boolean') {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    if (!setScoreHidden(body.scoreId, body.hidden)) {
      return reply.code(404).send({ ok: false, error: 'not_found' });
    }
    return { ok: true };
  });

  app.get('/api/admin/coop-scores', async () => ({ ok: true, rows: listCoopScoresForAdmin(100) }));

  app.post('/api/admin/coop-score-visibility', async (req, reply) => {
    const body = req.body as { scoreId?: unknown; hidden?: unknown } | undefined;
    if (typeof body?.scoreId !== 'number' || typeof body?.hidden !== 'boolean') {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    if (!setCoopScoreHidden(body.scoreId, body.hidden)) {
      return reply.code(404).send({ ok: false, error: 'not_found' });
    }
    return { ok: true };
  });
}
