import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { customAlphabet } from 'nanoid';
import { Room } from './room.js';
import { send, type C2S } from './protocol.js';

// 排除易混淆字符(0/O/1/I),房间码给人念/输的时候不容易出错
const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const rooms = new Map<string, Room>();

interface ConnCtx {
  room: Room | null;
  playerId: string | null;
}

export function attachRoomServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    const ctx: ConnCtx = { room: null, playerId: null };

    ws.on('message', (raw) => {
      let msg: C2S;
      try {
        msg = JSON.parse(raw.toString()) as C2S;
      } catch {
        send(ws, { t: 'error', msg: 'bad_json' });
        return;
      }
      try {
        handleMessage(ws, ctx, msg);
      } catch (err) {
        send(ws, { t: 'error', msg: err instanceof Error ? err.message : 'internal_error' });
      }
    });

    ws.on('close', () => {
      if (ctx.room && ctx.playerId) ctx.room.handleDisconnect(ctx.playerId);
    });
  });

  function handleMessage(ws: WebSocket, ctx: ConnCtx, msg: C2S): void {
    switch (msg.t) {
      case 'create_room': {
        let code = genCode();
        while (rooms.has(code)) code = genCode();
        const finalCode = code;
        const room = new Room(finalCode, () => rooms.delete(finalCode));
        rooms.set(finalCode, room);
        const player = room.addPlayer(msg.nick, ws);
        ctx.room = room;
        ctx.playerId = player.playerId;
        send(ws, { t: 'room_joined', code: finalCode, playerId: player.playerId, players: room.publicPlayers() });
        break;
      }
      case 'join_room': {
        const room = rooms.get(msg.code.toUpperCase());
        if (!room) {
          send(ws, { t: 'error', msg: 'room_not_found' });
          return;
        }
        if (room.players.length >= 2 || room.phase !== 'lobby') {
          send(ws, { t: 'error', msg: 'room_full' });
          return;
        }
        const player = room.addPlayer(msg.nick, ws);
        ctx.room = room;
        ctx.playerId = player.playerId;
        send(ws, { t: 'room_joined', code: room.code, playerId: player.playerId, players: room.publicPlayers() });
        room.broadcast({ t: 'room_update', players: room.publicPlayers() });
        break;
      }
      case 'ready':
        if (ctx.room && ctx.playerId) ctx.room.handleReady(ctx.playerId);
        break;
      case 'start':
        if (ctx.room && ctx.playerId) ctx.room.handleStart(ctx.playerId, msg.difficulty);
        break;
      case 'word_attempt':
        if (ctx.room && ctx.playerId) ctx.room.handleWordAttempt(ctx.playerId, msg.attempt);
        break;
      case 'skip_word':
        if (ctx.room && ctx.playerId) ctx.room.handleSkipWord(ctx.playerId, msg.wordId);
        break;
      case 'heartbeat':
        break;
      default:
        break;
    }
  }
}
