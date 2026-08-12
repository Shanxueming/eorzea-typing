/**
 * 每日挑战验收脚本。
 *
 * 断言:
 *   1. /api/daily/today 下发的 seed 和服务端自己算的一致
 *   2. ★ 用别的 seed 提交必须被拒(daily_seed_expired)——少了这条,玩家可以
 *      自己挑一个词特别简单的 seed 打完再当成今天的成绩交上来,
 *      「所有人打同一批词」这个前提就没了
 *   3. ★ 配置被改过的提交必须被拒(daily_config_mismatch)——比如拿简单难度
 *      的成绩来冒充今天的挑战
 *   4. 没通关的不收
 *   5. 老实打的能上榜,并且出现在今日榜里
 *   6. 每人每天只留最好的一条:更快的替换、更慢的不替换
 *
 * 纳入 `pnpm test`(见根 package.json)。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectPool, targetOf, createWordQueue } from '@eorzea/shared';
import { filterFeaturedWordPool, filterPoolByDifficulty } from '@eorzea/shared/battle';
import { DAILY_CHALLENGE_CONFIG, dailySeed } from '@eorzea/shared/challenge';
import type { WordBankFile } from '@eorzea/shared/types';

process.env.EORZEA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eorzea-daily-'));

const { startServer } = await import('../apps/server/src/app.ts');

async function main(): Promise<void> {
  const app = await startServer(0);
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('服务端没有绑定端口');
  const base = `http://127.0.0.1:${addr.port}`;

  const post = async (url: string, body: unknown) => {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const get = async (url: string) => {
    const res = await fetch(base + url);
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };

  try {
    // ── 1. 今日题面 ──
    const today = await get('/api/daily/today');
    assert.equal(today.status, 200);
    const seed = today.json.seed as string;
    assert.equal(seed, dailySeed(Date.now()), '下发的 seed 必须和服务端自己算的一致');
    assert.equal(today.json.difficulty, DAILY_CHALLENGE_CONFIG.difficulty, '题面要带固定配置');
    assert.ok(typeof today.json.endsAt === 'number', '要带换题时刻');

    const reg = await post('/api/account/register', {});
    const playerId = reg.json.displayId as string;
    const password = reg.json.password as string;

    // ── 造一局「真打」的数据,用今天的 seed 和固定配置 ──
    const bank = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data', 'wordbanks', 'starter.json'), 'utf8'),
    ) as WordBankFile;
    const pool = filterPoolByDifficulty(
      filterFeaturedWordPool(selectPool([bank], {
        categories: [...DAILY_CHALLENGE_CONFIG.categories],
        pureOnly: DAILY_CHALLENGE_CONFIG.pureOnly,
      })),
      DAILY_CHALLENGE_CONFIG.difficulty,
    );

    const buildAttempts = (s: string, count: number) => {
      const queue = createWordQueue(pool, s);
      const attempts = [];
      let t = 0;
      for (let i = 0; i < count; i++) {
        const w = queue.next();
        const target = targetOf(w, DAILY_CHALLENGE_CONFIG.mode);
        const startedAt = t + 200 + (i % 5) * 37;
        const keystrokes = [];
        let kt = startedAt + 150 + (i % 7) * 20;
        for (let k = 0; k < target.length; k++) {
          keystrokes.push({ t: kt, code: `Key${k}`, trusted: true, composing: false });
          kt += 90 + ((i * 13 + k * 29) % 110);
        }
        const submittedAt = kt + 40;
        attempts.push({
          wordId: w.id, startedAt, submittedAt, submitted: target, keystrokes,
          backspaces: i % 4 === 0 ? 1 : 0, compositionCommits: target.length, focusLostMs: 0,
        });
        t = submittedAt;
      }
      return { attempts, elapsedMs: t + 500 };
    };

    const { attempts, elapsedMs } = buildAttempts(seed, 30);
    const basePayload = {
      playerId, password, seed,
      gameMode: DAILY_CHALLENGE_CONFIG.gameMode,
      difficulty: DAILY_CHALLENGE_CONFIG.difficulty,
      inputMode: DAILY_CHALLENGE_CONFIG.inputMode,
      character: 'p1' as const,
      mode: DAILY_CHALLENGE_CONFIG.mode,
      categories: [...DAILY_CHALLENGE_CONFIG.categories],
      pureOnly: DAILY_CHALLENGE_CONFIG.pureOnly,
      attempts, elapsedMs,
    };

    // ── 2. ★ 换个 seed 提交必须被拒 ──
    const otherSeed = buildAttempts('some-other-seed-i-picked', 30);
    const wrongSeed = await post('/api/daily/submit', {
      ...basePayload,
      seed: 'some-other-seed-i-picked',
      attempts: otherSeed.attempts,
      elapsedMs: otherSeed.elapsedMs,
      claimed: { score: 5000, clearMs: otherSeed.elapsedMs },
    });
    assert.equal(wrongSeed.status, 409, '★ 用别的 seed 打的成绩不能收');
    assert.equal(wrongSeed.json.error, 'daily_seed_expired');

    // ── 3. ★ 改配置提交必须被拒 ──
    const wrongCfg = await post('/api/daily/submit', {
      ...basePayload,
      difficulty: 'easy',
      claimed: { score: 5000, clearMs: elapsedMs },
    });
    assert.equal(wrongCfg.status, 400, '★ 每日挑战的配置是固定的,改了不能收');
    assert.equal(wrongCfg.json.error, 'daily_config_mismatch');

    // ── 4. 没通关的不收 ──
    const notCleared = await post('/api/daily/submit', {
      ...basePayload,
      claimed: { score: 5000 },
    });
    assert.equal(notCleared.status, 400, '每日挑战按耗时排名,没通关就没成绩可比');
    assert.equal(notCleared.json.error, 'not_cleared');

    // ── 5. 老实打的能上榜 ──
    const honest = await post('/api/daily/submit', {
      ...basePayload,
      claimed: { score: 5000, clearMs: elapsedMs },
    });
    assert.equal(honest.status, 200, `老实打的应该能上榜,实际 ${JSON.stringify(honest.json)}`);
    assert.equal(honest.json.status, 'inserted');

    const board = await get('/api/daily/leaderboard');
    assert.equal(board.status, 200);
    const rows = board.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1, '今日榜应该有一条成绩');
    assert.equal(rows[0].displayId, playerId);
    assert.equal(rows[0].clearMs, elapsedMs);

    // ── 6. 每人每天只留最好的一条 ──
    const slower = await post('/api/daily/submit', {
      ...basePayload,
      claimed: { score: 5000, clearMs: elapsedMs + 10_000 },
    });
    assert.equal(slower.json.status, 'not_better', '更慢的成绩不该替换');

    const faster = await post('/api/daily/submit', {
      ...basePayload,
      claimed: { score: 5000, clearMs: elapsedMs - 5_000 },
    });
    assert.equal(faster.json.status, 'improved', '更快的成绩应该替换');

    const board2 = await get('/api/daily/leaderboard');
    const rows2 = board2.json.rows as Array<Record<string, unknown>>;
    assert.equal(rows2.length, 1, '同一个人当天只留一条,不该出现两行');
    assert.equal(rows2[0].clearMs, elapsedMs - 5_000, '榜上留的应该是更快的那条');

    // eslint-disable-next-line no-console
    console.log('[smoke-daily] OK — seed 由服务端定、换seed/改配置/没通关全部拦下、每人每天只留最好一条');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke-daily] FAILED —', err);
  process.exit(1);
});
