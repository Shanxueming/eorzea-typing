/**
 * M3 验收脚本:起一个临时服务端实例,用两个真实 WebSocket 客户端跑完整局联机对战。
 * 断言:
 *   1. 两端 battle_start 收到的 seed / categories 完全相同
 *   2. 第三个客户端加入满员房间被拒绝(room_full)
 *   3. bossHp 在整场战斗中单调不增
 *   4. battle_end 的 results 长度为 2,且按分数排序后顺序自洽
 *   5. ★ 客户端与服务端的词队列始终不错位:按 CoopBattle.tsx 的规则消费队列,
 *      每一次普通词提交都必须被服务端记账(wordsCompleted 逐次递增)
 *
 * 纳入 `pnpm test`(见根 package.json)。
 *
 * ★ 第 5 条断言(词队列不错位)是这里最重要的一条,别为了跑得快把它删了。
 *   泰坦之怒现在按概率插在普通词结算之后,而客户端打对普通词时是乐观推进的,
 *   所以「服务端消费队列的次数」必须和「客户端消费队列的次数」逐次对齐。曾经
 *   服务端在触发泰坦之怒的那次跳过了 drawNext,两边就此永久错开一格,之后所有
 *   word_attempt 都被服务端按 wordId 不匹配静默丢弃,玩家打不出伤害只被超时
 *   扣血到团灭 —— 而当时的冒烟测试完全测不出来,因为它没有模拟客户端在
 *   cast_resolved 之后的行为。下面的 clientQueue 严格照抄 CoopBattle.tsx 的
 *   消费时机,任何一侧改了推进规则,这条断言都会立刻变红。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { selectPool, targetOf, createWordQueue } from '@eorzea/shared';
import { filterFeaturedWordPool, filterPoolByDifficulty } from '@eorzea/shared/battle';
import { currentMechanicWords } from '@eorzea/shared/mechanics';
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
  waitFor(pred: (m: S2C) => boolean, timeoutMs?: number, label?: string): Promise<S2C>;
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
    waitFor: (pred, timeoutMs = 10000, label = 'message') => {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
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
  // 断言失败时也要把客户端连接关掉再关服务端,否则 app.close() 会一直等这些
  // 还开着的 WebSocket,脚本挂死在那里,CI 上看到的是超时而不是失败原因。
  const sockets: WebSocket[] = [];

  try {
    const a = createClient(url);
    const b = createClient(url);
    sockets.push(a.ws, b.ws);
    await Promise.all([a.open(), b.open()]);

    a.send({ t: 'create_room', nick: 'Alice' });
    const joinedA = (await a.waitFor((m) => m.t === 'room_joined')) as Extract<S2C, { t: 'room_joined' }>;
    const code = joinedA.code;

    b.send({ t: 'join_room', code, nick: 'Bob' });
    const joinedB = (await b.waitFor((m) => m.t === 'room_joined')) as Extract<S2C, { t: 'room_joined' }>;
    assert.equal(joinedB.code, code, '两端应加入同一个房间码');

    // 第三个客户端应该被拒绝(容量固定 2 人)
    const c = createClient(url);
    sockets.push(c.ws);
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
    // 逐字输入:脚本每次都提交完整正确答案,组合输入下的「错了再改」没法用
    // 这种一次性提交模拟,而且判负规则也不同。
    a.send({ t: 'start', difficulty: 'normal', inputMode: 'sequential' });

    const startA = (await a.waitFor((m) => m.t === 'battle_start')) as Extract<S2C, { t: 'battle_start' }>;
    const startB = (await b.waitFor((m) => m.t === 'battle_start')) as Extract<S2C, { t: 'battle_start' }>;
    assert.equal(startA.config.seed, startB.config.seed, '两端 seed 必须相同');
    assert.deepEqual(startA.config.categories, startB.config.categories, '两端 categories 必须相同');

    const config = startA.config;
    const banks = await Promise.all(config.categories.map(loadBank));
    // ★ 必须和服务端(Room.startBattle)、真实客户端(CoopBattle.tsx)用完全同一条
    //   流水线:selectPool → filterFeaturedWordPool → filterPoolByDifficulty。
    //   少任何一步、或者难度传错,两边词池就不同,词序从第一个词起全错开,后果和
    //   真的队列错位一模一样。这里每加一层筛选,三处调用点都得同步改 —— 下面那条
    //   wordsCompleted 断言就是专门用来在忘记同步时立刻变红的。
    const pool = filterPoolByDifficulty(
      filterFeaturedWordPool(
        selectPool(banks, { categories: config.categories, pureOnly: config.pureOnly }),
      ),
      startA.difficulty,
    );
    assert.ok(pool.length > 0, '词池不应为空');

    /**
     * 客户端侧的词队列。消费时机严格照抄 apps/web/src/scenes/CoopBattle.tsx:
     *   1. 进战斗时取第一个词
     *   2. 打对普通词后立刻乐观推进一格
     *   3. 收到 word_advanced(服务端判了 miss)且 wordId 对得上时推进一格
     *   4. 收到 cast_resolved 时【不推进】—— 泰坦之怒是插进来的挑战,
     *      普通词在打断期间原地冻结,打完接着打同一个词
     * 服务端(Room)必须与这四条逐次对齐,对不齐就会走到 handleWordAttempt 里
     * 「wordId 不匹配 → 直接 return」那条分支,提交被静默丢弃。
     */
    const clientQueue = createWordQueue(pool, config.seed);
    let currentWord: WordEntry = clientQueue.next();
    let mechStart: Extract<S2C, { t: 'mechanic_start' }> | null = null;
    let seenAdvance: string | null = null;
    let ended = false;
    let normalSubmits = 0;
    let castCount = 0;

    a.subscribe((m) => {
      if (m.t === 'battle_end') ended = true;
      if (m.t === 'mechanic_start') {
        mechStart = m;
        castCount++;
      }
      if (m.t === 'mechanic_progress' && m.playerId === joinedA.playerId && mechStart) {
        mechStart = { ...mechStart, states: { ...mechStart.states, [m.playerId]: m.state } };
      }
      // ★ 机制结算时不消费词队列 —— 普通词在机制期间原地冻结,
      //   服务端 resumeNormalWord 同样不推进。这条是两边不错位的地基。
      if (m.t === 'mechanic_resolved') mechStart = null;
      if (m.t === 'word_advanced' && m.playerId === joinedA.playerId) {
        const key = `${m.playerId}:${m.wordId}`;
        if (seenAdvance !== key && currentWord.id === m.wordId) {
          seenAdvance = key;
          currentWord = clientQueue.next();
        }
      }
    });

    // 每打几下就停一拍,好歹让 250ms 一次的 score_tick 至少采到几个样,
    // 真正跑一遍 bossHp 单调不增这条断言,而不是零样本空过。
    const MAX_HITS = 150;
    for (let i = 0; i < MAX_HITS && !ended; i++) {
      const nowMs = Date.now() - startA.startAt;
      const mech: Extract<S2C, { t: 'mechanic_start' }> | null = mechStart;
      if (mech) {
        // 机制期间打机制给的词,普通词队列一格都不动。
        // 三连桶要走好几步、三穿一要打三个,所以循环提交直到服务端宣布结算。
        for (let step = 0; step < 8 && mechStart; step++) {
          const st = mechStart.states[joinedA.playerId];
          if (!st) break;
          const words = currentMechanicWords(st);
          if (words.length === 0) break;
          // 多候选(三连桶的左右)时挑能把自己送到石头那一侧的那个
          const pick = st.barrel
            ? (st.barrel.position < st.barrel.stoneIndex ? st.barrel.rightWord : st.barrel.leftWord)
            : words[0];
          a.send({ t: 'word_attempt', attempt: buildAttempt(pick, config.mode, Date.now() - startA.startAt) });
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        await a.waitFor((m) => m.t === 'mechanic_resolved', 20000, 'mechanic_resolved');
      } else {
        const attempt = buildAttempt(currentWord, config.mode, nowMs);
        a.send({ t: 'word_attempt', attempt });
        b.send({ t: 'word_attempt', attempt: { ...attempt } });
        normalSubmits++;
        currentWord = clientQueue.next();
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // 队列一旦错位,后续提交全被服务端按 wordId 不匹配丢弃,Boss 掉不完血,战斗要
    // 拖满 180 秒才结束 —— 所以这里等不到 battle_end 的头号嫌疑就是错位,
    // 把这句写进超时消息里,免得下一个人对着光秃秃的 "timeout" 猜半天。
    const endA = (await a.waitFor(
      (m) => m.t === 'battle_end',
      15000,
      `battle_end(已提交 ${normalSubmits} 次普通词、触发 ${castCount} 次机制仍打不完;`
        + '最可能的原因是客户端与服务端的词队列错位,提交被静默丢弃)',
    )) as Extract<S2C, { t: 'battle_end' }>;

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

    // ★ 词队列不错位:Alice 每一次普通词提交都打的是正确答案,服务端就必须每一次
    //   都记账。少一次就说明某条分支上两边的队列游标对不齐了,后续提交全被丢弃。
    const alice = endA.results.find((r) => r.playerId === joinedA.playerId);
    assert.ok(alice, 'results 里应能找到 Alice');
    assert.equal(
      alice.wordsCompleted,
      normalSubmits,
      `词队列错位:提交了 ${normalSubmits} 次正确的普通词,服务端只记账 ${alice.wordsCompleted} 次`,
    );
    assert.equal(alice.misses, 0, `不该有 miss,实际 ${alice.misses} 次(多半是队列错位后被超时判负)`);

    a.ws.close();
    b.ws.close();

    // eslint-disable-next-line no-console
    console.log('[smoke-coop] OK —', {
      seed: config.seed,
      categories: config.categories,
      bossHpSamples: bossHpSeries.length,
      normalSubmits,
      castCount,
      results: endA.results.map((r) => ({ nick: r.nick, score: r.score })),
    });
  } finally {
    for (const ws of sockets) ws.close();
    await app.close();
  }
}

main().catch((err) => {
  console.error('[smoke-coop] FAILED:', err);
  process.exitCode = 1;
});
