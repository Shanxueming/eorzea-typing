/**
 * 联机大厅验收脚本:起一个临时服务端,用真实 WebSocket 开房,再通过 HTTP
 * 拉大厅列表,断言列表内容和可见性规则都对。
 *
 * 断言:
 *   1. 公开房开出来后能在 /api/coop/rooms 里看到,字段齐全
 *   2. ★ 私密房(isPublic: false)不出现在列表里 —— 这条是隐私承诺本身,
 *      漏了的话玩家勾了"不挂大厅"却照样被所有人看到
 *   3. ★ 列表不泄露账号 ID —— 大厅是免登录的公开接口,把 displayId 摊上去
 *      等于给登录接口送一份在线用户名字典
 *   4. 满员的房间从列表里消失(不然点进去只会吃一个 room_full)
 *   5. 房主断线、房间空掉之后,列表里也要跟着消失
 *
 * 纳入 `pnpm test`(见根 package.json)。
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../apps/server/src/app.ts';
import type { C2S, S2C } from '../apps/server/src/rooms/protocol.ts';

interface LobbyRoom {
  code: string;
  hostNick: string;
  playerCount: number;
  createdAt: number;
}

function createClient(url: string) {
  const ws = new WebSocket(url);
  const waiters: { pred: (m: S2C) => boolean; resolve: (m: S2C) => void; reject: (e: Error) => void }[] = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as S2C;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    ws,
    open: () => new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    }),
    send: (msg: C2S) => ws.send(JSON.stringify(msg)),
    waitFor: (pred: (m: S2C) => boolean, label = 'message') => new Promise<S2C>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等 ${label} 超时`)), 5000);
      waiters.push({
        pred,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    }),
  };
}

async function main(): Promise<void> {
  const app = await startServer(0);
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const httpBase = `http://127.0.0.1:${address.port}`;

  const listRooms = async (): Promise<LobbyRoom[]> => {
    const res = await fetch(`${httpBase}/api/coop/rooms`);
    const json = await res.json() as { ok: boolean; rooms: LobbyRoom[] };
    assert.equal(json.ok, true, '/api/coop/rooms 应该返回 ok:true');
    return json.rooms;
  };

  const sockets: WebSocket[] = [];
  try {
    assert.deepEqual(await listRooms(), [], '一间房都没开的时候列表应该是空的');

    // ── 1. 公开房出现在列表里,字段齐全 ──
    const host = createClient(wsUrl);
    sockets.push(host.ws);
    await host.open();
    host.send({ t: 'create_room', nick: '公开房主', isPublic: true });
    const joined = await host.waitFor((m) => m.t === 'room_joined', 'room_joined') as Extract<S2C, { t: 'room_joined' }>;

    let rooms = await listRooms();
    assert.equal(rooms.length, 1, '公开房应该出现在大厅列表里');
    assert.equal(rooms[0].code, joined.code, '列表里的房间码要和开出来的一致');
    assert.equal(rooms[0].hostNick, '公开房主', '列表要带房主昵称');
    assert.equal(rooms[0].playerCount, 1, '刚开的房里只有房主一个人');
    assert.ok(typeof rooms[0].createdAt === 'number' && rooms[0].createdAt > 0, '要带开房时间');

    // ── 3. 不泄露账号 ID ──
    assert.ok(
      !Object.keys(rooms[0]).some((k) => /display|account|player_?id/i.test(k)),
      '★ 大厅是免登录的公开接口,不能把账号 ID 暴露出去',
    );

    // ── 2. 私密房不出现在列表里 ──
    const secret = createClient(wsUrl);
    sockets.push(secret.ws);
    await secret.open();
    secret.send({ t: 'create_room', nick: '私密房主', isPublic: false });
    const secretJoined = await secret.waitFor((m) => m.t === 'room_joined', 'room_joined') as Extract<S2C, { t: 'room_joined' }>;

    rooms = await listRooms();
    assert.equal(rooms.length, 1, '★ 私密房不能出现在大厅列表里');
    assert.ok(!rooms.some((r) => r.code === secretJoined.code), '★ 私密房的房间码不能被列出来');

    // 但私密房仍然能靠房间码进 —— 私密只是不挂大厅,不是不能玩
    const secretGuest = createClient(wsUrl);
    sockets.push(secretGuest.ws);
    await secretGuest.open();
    secretGuest.send({ t: 'join_room', code: secretJoined.code, nick: '受邀的人' });
    await secretGuest.waitFor((m) => m.t === 'room_joined', '私密房 room_joined');

    // ── 4. 满员的房从列表里消失 ──
    const guest = createClient(wsUrl);
    sockets.push(guest.ws);
    await guest.open();
    guest.send({ t: 'join_room', code: joined.code, nick: '路人' });
    await guest.waitFor((m) => m.t === 'room_joined', '公开房 room_joined');

    rooms = await listRooms();
    assert.equal(rooms.length, 0, '★ 满员的房间不该继续列在大厅里,点进去只会吃 room_full');

    // ── 5. 人走光之后房间从列表里消失 ──
    const solo = createClient(wsUrl);
    sockets.push(solo.ws);
    await solo.open();
    solo.send({ t: 'create_room', nick: '待会就走', isPublic: true });
    await solo.waitFor((m) => m.t === 'room_joined', 'room_joined');
    assert.equal((await listRooms()).length, 1, '新开的公开房应该在列表里');

    solo.ws.close();
    // 等服务端处理完 close 事件(房间空了会自己销毁)
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await listRooms()).length, 0, '★ 房主断线、房间空掉之后要从列表里消失');

    // eslint-disable-next-line no-console
    console.log('[smoke-lobby] OK — 公开房可见、私密房隐藏、不泄露账号ID、满员与空房自动下架');
  } finally {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke-lobby] FAILED —', err);
  process.exit(1);
});
