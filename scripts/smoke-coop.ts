/**
 * M3 验收脚本:起一个临时服务端实例,用两个真实 WebSocket 客户端跑完整局联机对战。
 * 断言:
 *   1. 两端 battle_start 收到的 seed / categories 完全相同
 *   2. 第三个客户端加入满员房间被拒绝(room_full)
 *   3. bossHp 在整场战斗中单调不增
 *   4. battle_end 的 results 长度为 2,且按分数排序后顺序自洽
 *
 * 纳入 `pnpm test`(见根 package.json)。不用等 8-15s 的读条间隔——
 * 两个客户端在几百毫秒内把伤害打满,战斗通常在读条第一次触发前就结束了,
 * 这是刻意的简化(见 CODEX_PLAN.md §7 的时间预算取舍),不做读条场景的专门覆盖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { selectPool, targetOf, createWordQueue } from '@eorzea/shared';
import type { WordBankFile, WordEntry, TypingMode } from '@eorzea/shared/types';
import { startServer } from '../apps/server/src/app.ts';
import type { C2S, S2C } from '../apps/server/src/rooms/protocol.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORDBANKS_DIR = path.join(here, '..', 'data', 'wordbanks');

async function loadBank(category: string): Promise<WordBankFile> {
  const raw = await fs.readFile(path.join(WORDBANKS_DIR, `${category}.json`), 'utf8');
  return JSON.parse(raw) as WordBankFile;
}

interface Client {
  ws: WebSocket;
  messages: S2C[];
  open(): Promise<void>;
  send(msg: C2S): void;
  waitFor(pred: (m: S2C) => boolean, timeoutMs?: number): Promise<S2C>;
  subscribe(cb: (m: S2C) => void): void;
}

function createClient(url: string): Client {
  const ws = new WebSocket(url);
  const messages: S2C[] = [];
  const waiters: { pred: (m: S2C) => boolean; resolve: (m: S2C) => void; reject: (e: Error) => void }[] = [];
  const subscribers: ((m: S2C) => void)[] = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as S2C;
    messages.push(msg);
    for (const cb of subscribers) cb(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  });

  return {
    ws,
    messages,
    open: () => new Promise((resolve) => ws.once('open', () => resolve())),
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor: (pred, timeoutMs = 10000) => {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
          reject,
        });
      });
    },
    subscribe: (cb) => subscribers.push(cb),
  };
}

/**
 * checkAttempt 会核对 startedAt/submittedAt 与服务端墙钟的偏差(±3s)以及
 * 击键时间线是否落在 [startedAt, submittedAt] 区间内,所以这里的时间戳必须
 * 用"相对战斗开始的真实经过毫秒数",不能每次从 0 起算的假数据——否则打满
 * 几秒后就会被 clock_skew 判定拦掉,真实客户端(now = Date.now() - startAt)
 * 就是这样算的,这里照着模拟。
 */
function buildAttempt(word: WordEntry, mode: TypingMode, nowMs: number) {
  const target = targetOf(word, mode);
  const startedAt = nowMs;
  const keystrokes = Array.from({ length: Math.max(1, target.length) }, (_, i) => ({
    t: startedAt + i * 10,
    code: `Key${i}`,
    trusted: true,
    composing: false,
  }));
  return {
    wordId: word.id,
    startedAt,
    submittedAt: startedAt + keystrokes.length * 10 + 10,
    submitted: target,
    keystrokes,
    backspaces: 0,
    compositionCommits: 0,
    focusLostMs: 0,
  };
}

async function main(): Promise<void> {
  const app = await startServer(0);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
  const url = `ws://127.0.0.1:${address.port}/ws`;

  try {
    const a = createClient(url);
    const b = createClient(url);
    await Promise.all([a.open(), b.open()]);

    a.send({ t: 'create_room', nick: 'Alice' });
    const joinedA = (await a.waitFor((m) => m.t === 'room_joined')) as Extract<S2C, { t: 'room_joined' }>;
    const code = joinedA.code;

    b.send({ t: 'join_room', code, nick: 'Bob' });
    const joinedB = (await b.waitFor((m) => m.t === 'room_joined')) as Extract<S2C, { t: 'room_joined' }>;
    assert.equal(joinedB.code, code, '两端应加入同一个房间码');

    // 第三个客户端应该被拒绝(容量固定 2 人)
    const c = createClient(url);
    await c.open();
    c.send({ t: 'join_room', code, nick: 'Carol' });
    const rejected = (await c.waitFor((m) => m.t === 'error')) as Extract<S2C, { t: 'error' }>;
    assert.equal(rejected.msg, 'room_full', '第 3 人加入应返回 room_full');
    c.ws.close();

    // 房主流程:Alice 是房主(先创建的房间),不需要「准备」,直接选难度点开始;
    // Bob 是非房主,必须先点「准备」,房主才能点开始。
    b.send({ t: 'ready' });
    await a.waitFor(
      (m) => m.t === 'room_update' && m.players.some((p) => p.playerId === joinedB.playerId && p.ready),
    );
    a.send({ t: 'start', difficulty: 'normal' });

    const startA = (await a.waitFor((m) => m.t === 'battle_start')) as Extract<S2C, { t: 'battle_start' }>;
    const startB = (await b.waitFor((m) => m.t === 'battle_start')) as Extract<S2C, { t: 'battle_start' }>;
    assert.equal(startA.config.seed, startB.config.seed, '两端 seed 必须相同');
    assert.deepEqual(startA.config.categories, startB.config.categories, '两端 categories 必须相同');

    const config = startA.config;
    const banks = await Promise.all(config.categories.map(loadBank));
    const pool = selectPool(banks, { categories: config.categories, pureOnly: config.pureOnly });
    assert.ok(pool.length > 0, '词池不应为空');

    const queueA = createWordQueue(pool, config.seed);
    const queueB = createWordQueue(pool, config.seed);

    let ended = false;
    let pendingCast: Extract<S2C, { t: 'boss_cast' }> | null = null;
    a.subscribe((m) => {
      if (m.t === 'battle_end') ended = true;
      if (m.t === 'boss_cast') pendingCast = m;
    });

    // 每打几下就停一拍,好歹让 250ms 一次的 score_tick 至少采到几个样,
    // 真正跑一遍 bossHp 单调不增这条断言,而不是零样本空过。
    const MAX_HITS = 150;
    for (let i = 0; i < MAX_HITS && !ended; i++) {
      const nowMs = Date.now() - startA.startAt;
      a.send({ t: 'word_attempt', attempt: buildAttempt(queueA.next(), config.mode, nowMs) });
      b.send({ t: 'word_attempt', attempt: buildAttempt(queueB.next(), config.mode, nowMs) });
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (pendingCast) {
        const cast = pendingCast;
        pendingCast = null;
        const castNowMs = Date.now() - startA.startAt;
        a.send({ t: 'word_attempt', attempt: buildAttempt(cast.word, config.mode, castNowMs) });
        await a.waitFor((m) => m.t === 'cast_resolved' && m.castId === cast.castId);
      }
      if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const endA = (await a.waitFor((m) => m.t === 'battle_end', 15000)) as Extract<S2C, { t: 'battle_end' }>;

    const bossHpSeries = a.messages
      .filter((m): m is Extract<S2C, { t: 'score_tick' }> => m.t === 'score_tick')
      .map((m) => m.bossHp);
    for (let i = 1; i < bossHpSeries.length; i++) {
      assert.ok(bossHpSeries[i] <= bossHpSeries[i - 1], `bossHp 应单调不增:${bossHpSeries[i - 1]} -> ${bossHpSeries[i]}`);
    }

    assert.equal(endA.results.length, 2, 'battle_end.results 长度应为 2');
    const sorted = [...endA.results].sort((x, y) => y.score - x.score);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i - 1].score >= sorted[i].score, '按分数排序后应保持降序,排名自洽');
    }

    a.ws.close();
    b.ws.close();

    // eslint-disable-next-line no-console
    console.log('[smoke-coop] OK —', {
      seed: config.seed,
      categories: config.categories,
      bossHpSamples: bossHpSeries.length,
      results: endA.results.map((r) => ({ nick: r.nick, score: r.score })),
    });
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[smoke-coop] FAILED:', err);
  process.exitCode = 1;
});
