import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { customAlphabet } from 'nanoid';
import type { WordAttempt } from '@eorzea/shared/types';
import type { CharacterId, Difficulty, GameMode, InputMode } from '@eorzea/shared/battle';
import { login } from '../db/players.js';
import { Room } from './room.js';
import { send, type C2S, type SessionCreds } from './protocol.js';

// 排除易混淆字符(0/O/1/I),房间码给人念/输的时候不容易出错
const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const rooms = new Map<string, Room>();

/**
 * 联机大厅列出的房间上限。大厅是不需要登录的公开接口,不封顶的话房间一多
 * 每次刷新都在序列化整张表;而且大厅的用途是"找个人一起打",不是"看全站有多少房"。
 */
const MAX_LOBBY_ROOMS = 30;

/**
 * 联机大厅:还在等人的公开房间,新开的排前面。
 *
 * ★ 这是**不需要登录**的公开列表,所以只回 lobbyInfo() 那几个字段
 *   (房间码/房主昵称/人数/开房时间),不带账号 ID —— 理由见 Room.lobbyInfo。
 */
export function listOpenRooms(): Array<ReturnType<Room['lobbyInfo']>> {
  const open: Room[] = [];
  for (const room of rooms.values()) {
    if (room.isJoinableFromLobby()) open.push(room);
  }
  return open
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_LOBBY_ROOMS)
    .map((room) => room.lobbyInfo());
}

/** 昵称长度上限,与 Room 里的截断口径一致 */
const MAX_NICK_LENGTH = 16;
/** 单条消息的字节上限。正常的 word_attempt 带几十个击键,几 KB 足够 */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** 每个连接每秒最多处理多少条消息,超出直接丢弃 */
const MAX_MESSAGES_PER_SECOND = 60;

interface ConnCtx {
  room: Room | null;
  playerId: string | null;
  /** 当前限流窗口的起点与已处理条数 */
  windowStartedAt: number;
  messagesInWindow: number;
}

/** 昵称必须是非空字符串;两端空白去掉后按上限截断,不接受对象/数字等类型 */
function sanitizeNick(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_NICK_LENGTH);
}

/** 房间码固定 6 位,字母数字,大小写不敏感 */
function sanitizeRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'hell'];

function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
}

const CHARACTERS: readonly CharacterId[] = ['p1', 'p2'];

function isCharacter(value: unknown): value is CharacterId {
  return typeof value === 'string' && (CHARACTERS as readonly string[]).includes(value);
}

const INPUT_MODES: readonly InputMode[] = ['sequential', 'composed'];

function isInputMode(value: unknown): value is InputMode {
  return typeof value === 'string' && (INPUT_MODES as readonly string[]).includes(value);
}

const GAME_MODES: readonly GameMode[] = ['standard', 'endless'];

function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && (GAME_MODES as readonly string[]).includes(value);
}

/**
 * 登录态是可选的:带了就核对一次身份,核对通过就把账号信息带进房间——
 * 不通过或者没带,照样能进房间玩,只是这个人不计入排行榜资格。
 * 密码核对完立刻用完即弃,不在这个函数之外的任何地方出现。
 */
function resolveAccount(session: unknown): { id: string; displayId: string } | null {
  if (!session || typeof session !== 'object') return null;
  const s = session as SessionCreds;
  if (typeof s.displayId !== 'string' || typeof s.password !== 'string') return null;
  const result = login(s.displayId, s.password);
  if (!result.ok) return null;
  return { id: result.player.id, displayId: result.player.display_id };
}

/**
 * word_attempt 的形状校验。只看结构,不看内容 —— 内容真伪由 checkAttempt 与
 * analyzeSession 两层反作弊负责,这里只保证后续代码不会在 undefined 上取属性。
 */
function isWordAttempt(value: unknown): value is WordAttempt {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return typeof a.wordId === 'string'
    && typeof a.submitted === 'string'
    && typeof a.startedAt === 'number'
    && typeof a.submittedAt === 'number'
    && typeof a.backspaces === 'number'
    && typeof a.compositionCommits === 'number'
    && typeof a.focusLostMs === 'number'
    && Array.isArray(a.keystrokes)
    && a.keystrokes.every((k) => !!k && typeof k === 'object' && typeof (k as { t?: unknown }).t === 'number');
}

export function attachRoomServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws: WebSocket) => {
    const ctx: ConnCtx = { room: null, playerId: null, windowStartedAt: 0, messagesInWindow: 0 };

    ws.on('message', (raw) => {
      // 简单的滑动窗口限流:一个连接每秒最多处理 MAX_MESSAGES_PER_SECOND 条,
      // 多出来的静默丢弃。正常客户端远达不到这个量,刷消息的连接也就伤不到别人。
      const nowMs = Date.now();
      if (nowMs - ctx.windowStartedAt >= 1000) {
        ctx.windowStartedAt = nowMs;
        ctx.messagesInWindow = 0;
      }
      ctx.messagesInWindow += 1;
      if (ctx.messagesInWindow > MAX_MESSAGES_PER_SECOND) return;

      let msg: C2S;
      try {
        msg = JSON.parse(raw.toString()) as C2S;
      } catch {
        send(ws, { t: 'error', msg: 'bad_json' });
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
        send(ws, { t: 'error', msg: 'bad_message' });
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
        // 一个连接只能占一个房间。不拦的话反复发 create_room 就能无限造房,
        // 每个房间还都留在 rooms 里等永远不会到来的第二个人。
        if (ctx.room) {
          send(ws, { t: 'error', msg: 'already_in_room' });
          return;
        }
        const nick = sanitizeNick(msg.nick);
        if (!nick) {
          send(ws, { t: 'error', msg: 'bad_nick' });
          return;
        }
        let code = genCode();
        while (rooms.has(code)) code = genCode();
        const finalCode = code;
        const room = new Room(finalCode, () => rooms.delete(finalCode));
        // 不传就按公开处理:老客户端没这个字段,它们开的房也该能在大厅里被看到
        room.isPublic = msg.isPublic !== false;
        rooms.set(finalCode, room);
        const player = room.addPlayer(nick, ws, resolveAccount(msg.session));
        ctx.room = room;
        ctx.playerId = player.playerId;
        send(ws, { t: 'room_joined', code: finalCode, playerId: player.playerId, players: room.publicPlayers() });
        break;
      }
      case 'join_room': {
        if (ctx.room) {
          send(ws, { t: 'error', msg: 'already_in_room' });
          return;
        }
        const nick = sanitizeNick(msg.nick);
        if (!nick) {
          send(ws, { t: 'error', msg: 'bad_nick' });
          return;
        }
        const code = sanitizeRoomCode(msg.code);
        if (!code) {
          send(ws, { t: 'error', msg: 'room_not_found' });
          return;
        }
        const room = rooms.get(code);
        if (!room) {
          send(ws, { t: 'error', msg: 'room_not_found' });
          return;
        }
        if (room.players.length >= 2 || room.phase !== 'lobby') {
          send(ws, { t: 'error', msg: 'room_full' });
          return;
        }
        const player = room.addPlayer(nick, ws, resolveAccount(msg.session));
        ctx.room = room;
        ctx.playerId = player.playerId;
        send(ws, { t: 'room_joined', code: room.code, playerId: player.playerId, players: room.publicPlayers() });
        room.broadcast({ t: 'room_update', players: room.publicPlayers() });
        break;
      }
      case 'ready':
        if (ctx.room && ctx.playerId) ctx.room.handleReady(ctx.playerId);
        break;
      case 'select_character':
        if (!isCharacter(msg.character)) return;
        if (ctx.room && ctx.playerId) ctx.room.handleSelectCharacter(ctx.playerId, msg.character);
        break;
      case 'use_skill':
        if (ctx.room && ctx.playerId) ctx.room.handleUseSkill(ctx.playerId);
        break;
      case 'start':
        // 难度必须是已知档位:未知值会让 DIFFICULTY_CAST_MULTIPLIER 查表落空,
        // 读条时长与普通词限时全都算成 NaN,计时器直接失效。
        if (!isDifficulty(msg.difficulty)) {
          send(ws, { t: 'error', msg: 'bad_difficulty' });
          return;
        }
        if (!isInputMode(msg.inputMode)) {
          send(ws, { t: 'error', msg: 'bad_input_mode' });
          return;
        }
        if (!isGameMode(msg.gameMode)) {
          send(ws, { t: 'error', msg: 'bad_game_mode' });
          return;
        }
        if (ctx.room && ctx.playerId) {
          ctx.room.handleStart(ctx.playerId, msg.difficulty, msg.inputMode, msg.gameMode, !!msg.submitScore);
        }
        break;
      case 'word_attempt':
        if (!isWordAttempt(msg.attempt)) {
          send(ws, { t: 'error', msg: 'bad_attempt' });
          return;
        }
        if (ctx.room && ctx.playerId) ctx.room.handleWordAttempt(ctx.playerId, msg.attempt);
        break;
      case 'skip_word':
        if (typeof msg.wordId !== 'string') return;
        if (ctx.room && ctx.playerId) ctx.room.handleSkipWord(ctx.playerId, msg.wordId);
        break;
      case 'heartbeat':
        break;
      default:
        break;
    }
  }
}
