/**
 * 账号 + 排行榜 + 管理后台的端到端冒烟测试。
 *
 * 起一个临时服务端(数据库落在临时目录,跑完就删),用真实 HTTP 请求走一遍:
 *   1. 申请账号 —— 拿到 ID、玩家密码、root 密码
 *   2. 登录 —— 对的能进、错的进不去
 *   3. 提交成绩 —— ★ 伪造的分数必须被服务端重放核算挡下来
 *   4. 排行榜 —— 只收困难/地狱、按赛道分开、排序正确
 *   5. 管理后台 —— 没令牌进不去;密码对但 TOTP 错也进不去;
 *      进去之后能用 root 密码核对身份、重置密码、下榜
 *
 * 纳入 `pnpm test`。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { targetOf } from '@eorzea/shared/scoring';
import { createWordQueue, filterFeaturedWordPool, filterPoolByDifficulty } from '@eorzea/shared/battle';
import { selectPool } from '@eorzea/shared/wordbank';
import type { WordBankFile, WordEntry } from '@eorzea/shared/types';

// 数据库目录必须在 import app 之前设好 —— database.ts 在模块加载时就会读它
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eorzea-test-'));
process.env.EORZEA_DATA_DIR = TMP_DIR;
process.env.EORZEA_ADMIN_USER = 'test-admin';
process.env.EORZEA_ADMIN_PASSWORD = 'test-admin-password';
// 二次口令模式(用户选的简单形式)。配了 TOTP_SECRET 会自动切到动态码,
// 这里刻意不配,测的就是静态口令这条路径。
process.env.EORZEA_ADMIN_SECOND_PASSWORD = 'test-second-password';

const { startServer } = await import('../apps/server/src/app.ts');
const { closeDb } = await import('../apps/server/src/db/database.ts');


async function main(): Promise<void> {
  const app = await startServer(0);
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('服务端没有绑定端口');
  const base = `http://127.0.0.1:${addr.port}`;

  const post = async (url: string, body: unknown, token?: string) => {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const get = async (url: string, token?: string) => {
    const res = await fetch(base + url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };

  try {
    // ── 1. 申请账号 ──
    const reg = await post('/api/account/register', {});
    assert.equal(reg.status, 200);
    const displayId = reg.json.displayId as string;
    const password = reg.json.password as string;
    const rootPassword = reg.json.rootPassword as string;
    assert.ok(displayId.includes('#'), `ID 应该带 # 后缀,实际 ${displayId}`);
    assert.ok(/#\d{3}$/.test(displayId), `# 后面应该是三位数字,实际 ${displayId}`);
    assert.ok(password.length >= 12, '玩家密码太短');
    assert.ok(rootPassword.length > password.length, 'root 密码应该比玩家密码更长');
    assert.notEqual(password, rootPassword, '两个密码不能一样');

    // 两次申请必须是不同的账号
    const reg2 = await post('/api/account/register', {});
    assert.notEqual(reg2.json.displayId, displayId, '两次申请拿到了同一个 ID');

    // ── 2. 登录 ──
    const okLogin = await post('/api/account/login', { id: displayId, password });
    assert.equal(okLogin.status, 200, '正确的密码应该能登录');

    const badLogin = await post('/api/account/login', { id: displayId, password: 'WRONGWRONG12' });
    assert.equal(badLogin.status, 401, '错误的密码不该能登录');

    // ★ root 密码不能拿来当登录密码用 —— 它只是找回身份的凭证
    const rootAsLogin = await post('/api/account/login', { id: displayId, password: rootPassword });
    assert.equal(rootAsLogin.status, 401, 'root 密码不该能直接登录');

    // 带横线/小写/空格的输入都应该被容忍
    const messy = await post('/api/account/login', {
      id: `  ${displayId}  `,
      password: password.toLowerCase(),
    });
    assert.equal(messy.status, 200, '大小写与空白应该被规范化');

    // ── 3. 提交成绩:先造一局「真打」的数据 ──
    const categories = ['starter'] as const;
    const bankRaw = fs.readFileSync(
      path.join(process.cwd(), 'data', 'wordbanks', 'starter.json'), 'utf8',
    );
    const bank = JSON.parse(bankRaw) as WordBankFile;
    const pool = filterPoolByDifficulty(
      filterFeaturedWordPool(selectPool([bank], { categories: [...categories], pureOnly: true })),
      'hard',
    );
    const seed = 'test-seed-0001';
    const queue = createWordQueue(pool, seed);

    // 造一批「像人打的」attempt:间隔有波动、偶尔退格
    const attempts = [];
    let t = 0;
    let damage = 0;
    let combo = 0;
    const words: WordEntry[] = [];
    for (let i = 0; i < 30; i++) {
      const w = queue.next();
      words.push(w);
      const target = targetOf(w, 'hanzi');
      const startedAt = t + 200 + (i % 5) * 37;
      const keystrokes = [];
      let kt = startedAt + 150 + (i % 7) * 20;
      for (let k = 0; k < target.length; k++) {
        keystrokes.push({ t: kt, code: `Key${k}`, trusted: true, composing: false });
        kt += 90 + ((i * 13 + k * 29) % 110); // 间隔有波动,不会被判「节奏过于均匀」
      }
      const submittedAt = kt + 40;
      attempts.push({
        wordId: w.id, startedAt, submittedAt, submitted: target,
        keystrokes, backspaces: i % 4 === 0 ? 1 : 0, compositionCommits: target.length, focusLostMs: 0,
      });
      t = submittedAt;
      damage += (w.difficulty * 100) * Math.min(1 + combo * 0.1, 3);
      combo += 1;
    }
    const elapsedMs = t + 500;

    const basePayload = {
      playerId: displayId, password,
      seed, gameMode: 'standard' as const, difficulty: 'hard' as const,
      inputMode: 'composed' as const, character: 'p1' as const, mode: 'hanzi' as const,
      categories: [...categories], pureOnly: true, attempts, elapsedMs,
    };

    // ★★★ 核心断言:虚报分数必须被挡下来
    const cheat = await post('/api/score/submit', {
      ...basePayload,
      claimed: { score: 999_999_999, clearMs: 1000 },
    });
    assert.equal(cheat.status, 422, '虚报的分数必须被服务端重放核算拒绝');
    assert.equal(cheat.json.error, 'score_overclaim', `期望 score_overclaim,实际 ${cheat.json.error}`);

    // ★ 编造不存在的词也必须被挡下来
    const fakeWords = await post('/api/score/submit', {
      ...basePayload,
      attempts: [{ ...attempts[0], wordId: 'totally-made-up-id' }],
      claimed: { score: 1, clearMs: 5000 },
    });
    assert.equal(fakeWords.status, 422, '编造的 wordId 必须被拒绝');
    assert.equal(fakeWords.json.error, 'word_not_in_sequence');

    // ★ 未通关的标准模式不收
    const notCleared = await post('/api/score/submit', { ...basePayload, claimed: { score: 100 } });
    assert.equal(notCleared.status, 400, '标准模式没通关不该收录');

    // ★ 简单/普通难度不进榜
    const unranked = await post('/api/score/submit', {
      ...basePayload, difficulty: 'normal', claimed: { score: 100, clearMs: 60_000 },
    });
    assert.equal(unranked.status, 400, '普通难度不该进榜');

    // 老实提交:分数报低一点,服务端会用自己算的覆盖
    const honest = await post('/api/score/submit', {
      ...basePayload, claimed: { score: 1, clearMs: 90_000 },
    });
    assert.equal(honest.status, 200, `诚实的提交应该被接受,实际 ${JSON.stringify(honest.json)}`);
    assert.equal(honest.json.status, 'inserted');

    // ── 4. 排行榜 ──
    const board = await get('/api/leaderboard?gameMode=standard&difficulty=hard&inputMode=composed');
    assert.equal(board.status, 200);
    const rows = board.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1, '榜上应该有一条');
    assert.equal(rows[0].displayId, displayId);
    assert.ok((rows[0].score as number) > 0, '服务端应该重算出一个正分');

    // 换一条赛道(逐字输入)应该是空的 —— 赛道要分开
    const otherTrack = await get('/api/leaderboard?gameMode=standard&difficulty=hard&inputMode=sequential');
    assert.equal((otherTrack.json.rows as unknown[]).length, 0, '不同输入模式必须分榜');

    // ★ 地狱榜必须按难度收敛输入模式。
    //   地狱强制逐字,「地狱 + 组合输入」这条赛道根本不存在 —— 曾经首页把地狱榜
    //   写死成 composed,结果玩家通关地狱、传了成绩、回首页看不到自己,
    //   榜单标题还写着「地狱 · 组合输入」。查询侧必须替调用方收敛,而不是回空榜。
    const hellPayload = {
      ...basePayload, difficulty: 'hell' as const, inputMode: 'sequential' as const,
      claimed: { score: 1, clearMs: 70_000 },
    };
    assert.equal((await post('/api/score/submit', hellPayload)).status, 200, '地狱成绩应该能上传');

    const hellAsComposed = await get('/api/leaderboard?gameMode=standard&difficulty=hell&inputMode=composed');
    assert.equal(hellAsComposed.json.inputMode, 'sequential',
      '请求地狱+组合输入时,服务端必须收敛成逐字并把实际赛道回给前端');
    assert.equal((hellAsComposed.json.rows as unknown[]).length, 1,
      '地狱榜不该因为请求方写了 composed 就变成空榜');

    const hellAsSequential = await get('/api/leaderboard?gameMode=standard&difficulty=hell&inputMode=sequential');
    assert.deepEqual(
      (hellAsSequential.json.rows as Array<{ displayId: string }>).map((r) => r.displayId),
      (hellAsComposed.json.rows as Array<{ displayId: string }>).map((r) => r.displayId),
      '地狱榜无论请求哪种输入模式,拿到的都该是同一条赛道',
    );

    // 同一人再交一个更快的,应该替换而不是新增
    const faster = await post('/api/score/submit', {
      ...basePayload, claimed: { score: 1, clearMs: 45_000 },
    });
    assert.equal(faster.json.status, 'improved', '更快的成绩应该替换旧的');
    const board2 = await get('/api/leaderboard?gameMode=standard&difficulty=hard&inputMode=composed');
    assert.equal((board2.json.rows as unknown[]).length, 1, '每人每条赛道只留一条');

    // 更慢的不该替换
    const slower = await post('/api/score/submit', {
      ...basePayload, claimed: { score: 1, clearMs: 120_000 },
    });
    assert.equal(slower.json.status, 'not_better', '更慢的成绩不该替换');

    // ── 5. 管理后台 ──
    const noAuth = await get('/api/admin/players');
    assert.equal(noAuth.status, 401, '没有令牌不该能进后台');

    const factor = await get('/api/admin/factor');
    assert.equal(factor.json.kind, 'password', '没配 TOTP 时应该用二次口令');

    const wrongPw = await post('/api/admin/login', {
      user: 'test-admin', password: 'nope', second: 'test-second-password',
    });
    assert.equal(wrongPw.status, 401, '密码错误不该放行');

    await new Promise((r) => setTimeout(r, 3100));

    // ★ 用户名错也不该放行,而且返回的原因要和「密码错」一样,不能泄露哪一项错了
    const wrongUser = await post('/api/admin/login', {
      user: 'not-the-admin', password: 'test-admin-password', second: 'test-second-password',
    });
    assert.equal(wrongUser.status, 401, '用户名错误不该放行');
    assert.equal(wrongUser.json.error, 'bad_credentials', '不该区分是用户名错还是密码错');

    await new Promise((r) => setTimeout(r, 3100)); // 等过节流窗口

    // ★ 用户名密码都对但二次口令错,同样不能进 —— 这就是二次认证存在的意义
    const wrongSecond = await post('/api/admin/login', {
      user: 'test-admin', password: 'test-admin-password', second: 'wrong-second',
    });
    assert.equal(wrongSecond.status, 401, '二次口令错误必须挡下来');
    assert.equal(wrongSecond.json.error, 'bad_second');

    await new Promise((r) => setTimeout(r, 3100));

    const adminOk = await post('/api/admin/login', {
      user: 'test-admin', password: 'test-admin-password', second: 'test-second-password',
    });
    assert.equal(adminOk.status, 200, `两步都对应该放行,实际 ${JSON.stringify(adminOk.json)}`);
    const token = adminOk.json.token as string;

    const players = await get('/api/admin/players', token);
    assert.equal(players.status, 200);
    assert.ok((players.json.total as number) >= 2, '后台应该能看到已注册的账号');
    // ★ 后台也不该看到任何哈希
    const listJson = JSON.stringify(players.json);
    assert.ok(!listJson.includes('password_hash') && !listJson.includes('root_hash'),
      '账号列表里不该出现任何哈希字段');

    // root 密码核对
    const rootOk = await post('/api/admin/verify-root', { id: displayId, rootPassword }, token);
    assert.equal(rootOk.json.matched, true, '正确的 root 密码应该核对通过');
    const rootBad = await post('/api/admin/verify-root', { id: displayId, rootPassword: 'WRONG' }, token);
    assert.equal(rootBad.json.matched, false, '错误的 root 密码不该通过');

    // 重置密码:新密码能登录,旧密码失效
    const reset = await post('/api/admin/reset-password', { id: displayId }, token);
    const newPassword = reset.json.password as string;
    assert.ok(newPassword && newPassword !== password, '应该返回一个新密码');
    assert.equal((await post('/api/account/login', { id: displayId, password: newPassword })).status, 200,
      '新密码应该能登录');
    assert.equal((await post('/api/account/login', { id: displayId, password })).status, 401,
      '旧密码应该失效');
    // ★ 重置登录密码不该动 root 密码 —— 否则下次再忘就没凭证了
    assert.equal((await post('/api/admin/verify-root', { id: displayId, rootPassword }, token)).json.matched,
      true, '重置登录密码后 root 密码应该照常有效');

    // 下榜
    const adminScores = await get('/api/admin/scores', token);
    const scoreId = (adminScores.json.rows as Array<{ id: number }>)[0].id;
    await post('/api/admin/score-visibility', { scoreId, hidden: true }, token);
    const hiddenBoard = await get('/api/leaderboard?gameMode=standard&difficulty=hard&inputMode=composed');
    assert.equal((hiddenBoard.json.rows as unknown[]).length, 0, '下榜后不该出现在榜上');
    await post('/api/admin/score-visibility', { scoreId, hidden: false }, token);
    assert.equal(((await get('/api/leaderboard?gameMode=standard&difficulty=hard&inputMode=composed'))
      .json.rows as unknown[]).length, 1, '恢复后应该重新出现');

    // 封禁的玩家不上榜也不能登录
    await post('/api/admin/ban', { id: displayId, banned: true }, token);
    assert.equal((await get('/api/leaderboard?gameMode=standard&difficulty=hard&inputMode=composed'))
      .json.rows.length ?? 0, 0, '封禁玩家的成绩不该出现在榜上');
    assert.equal((await post('/api/account/login', { id: displayId, password: newPassword })).status, 401,
      '封禁后不该能登录');

    // eslint-disable-next-line no-console
    console.log('[smoke-account] OK —', {
      示例ID: displayId,
      玩家密码位数: password.replace(/-/g, '').length,
      root密码位数: rootPassword.replace(/-/g, '').length,
      重放核算: '虚报分数/编造词/未通关/低难度 全部拦下',
      管理后台: '无令牌401、用户名错401、密码错401、二次口令错401、两步通过才放行',
    });
  } finally {
    await app.close();
    // ★ 必须先关数据库再删目录:Windows 上文件被进程占着时 rm 会 EPERM,
    //   而 SQLite 的句柄不会随 app.close() 一起释放。
    closeDb();
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      // 删不掉就算了,系统重启时临时目录自会清理,不该因此让测试失败
    }
  }
}

main().catch((err) => {
  console.error('[smoke-account] FAILED:', err);
  process.exitCode = 1;
});
