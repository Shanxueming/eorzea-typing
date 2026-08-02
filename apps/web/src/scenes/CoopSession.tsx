import { useEffect, useReducer, useRef } from 'react';
import type { BattleConfig, PlayerResult } from '@eorzea/shared/types';
import type { Difficulty } from '@eorzea/shared/battle';
import { audio } from '../engine/audio';
import { coopSocketUrl, type C2S, type PlayerPublic, type PlayerTick, type S2C } from '../engine/coopProtocol';
import { Lobby } from './Lobby';
import { CoopBattle, type CoopCastInfo } from './CoopBattle';
import { CoopResults } from './CoopResults';

interface SessionState {
  status: 'connecting' | 'lobby' | 'battle' | 'results' | 'error';
  code: string | null;
  playerId: string | null;
  players: PlayerPublic[];
  config: BattleConfig | null;
  startAt: number | null;
  difficulty: Difficulty;
  bossHp: number;
  teamHp: number;
  scores: PlayerTick[];
  castWarning: boolean;
  cast: CoopCastInfo | null;
  lastResolvedCastId: string | null;
  lastInterruptedBy: string | null;
  lastAdvancedWord: { playerId: string; wordId: string } | null;
  results: PlayerResult[] | null;
  victory: boolean;
  errorMsg: string | null;
}

const initialState: SessionState = {
  status: 'connecting',
  code: null,
  playerId: null,
  players: [],
  config: null,
  startAt: null,
  difficulty: 'normal',
  bossHp: 0,
  teamHp: 0,
  scores: [],
  castWarning: false,
  cast: null,
  lastResolvedCastId: null,
  lastInterruptedBy: null,
  lastAdvancedWord: null,
  results: null,
  victory: false,
  errorMsg: null,
};

type Action = S2C | { t: 'socket_open' } | { t: 'socket_close' };

function reduce(s: SessionState, a: Action): SessionState {
  switch (a.t) {
    case 'socket_open':
      return { ...s, status: 'lobby' };
    case 'socket_close':
      return s.status === 'battle' || s.status === 'results' ? s : { ...s, status: 'error', errorMsg: '连接已断开' };
    case 'room_joined':
      return { ...s, status: 'lobby', code: a.code, playerId: a.playerId, players: a.players, errorMsg: null };
    case 'room_update':
      return { ...s, players: a.players };
    case 'battle_start':
      return {
        ...s,
        status: 'battle',
        config: a.config,
        startAt: a.startAt,
        difficulty: a.difficulty,
        bossHp: a.config.bossHp,
        teamHp: 100,
        scores: [],
        castWarning: false,
        cast: null,
        lastResolvedCastId: null,
        lastInterruptedBy: null,
        lastAdvancedWord: null,
        victory: false,
      };
    case 'boss_cast_warning':
      return { ...s, castWarning: true };
    case 'boss_cast':
      return {
        ...s,
        castWarning: false,
        cast: { castId: a.castId, skillName: a.skillName, word: a.word, castMs: a.castMs, startedAt: Date.now() },
      };
    case 'cast_resolved':
      return { ...s, cast: null, lastResolvedCastId: a.castId, lastInterruptedBy: a.interruptedBy };
    case 'word_advanced':
      return { ...s, lastAdvancedWord: { playerId: a.playerId, wordId: a.wordId } };
    case 'score_tick':
      return { ...s, scores: a.scores, bossHp: a.bossHp, teamHp: a.teamHp };
    case 'battle_end':
      return { ...s, status: 'results', results: a.results, victory: a.victory };
    case 'error':
      return { ...s, errorMsg: a.msg };
    default:
      return s;
  }
}

export interface CoopSessionProps {
  onExit: () => void;
  onVictory: () => void;
}

export function CoopSession({ onExit, onVictory }: CoopSessionProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const recordedVictoryRef = useRef(false);
  const [state, dispatch] = useReducer(reduce, initialState);

  useEffect(() => {
    if (state.status === 'results' && state.victory && !recordedVictoryRef.current) {
      recordedVictoryRef.current = true;
      audio.play('victory');
      onVictory();
    }
  }, [state.status, state.victory, onVictory]);

  // 联机也和单机一样只在战斗期间播放 BGM；素材缺失时 AudioEngine 静默降级。
  useEffect(() => {
    if (state.status !== 'battle') {
      audio.stopBgm();
      return;
    }
    let active = true;
    void audio.loadBgm().then(() => {
      if (active) audio.startBgm();
    });
    return () => {
      active = false;
      audio.stopBgm();
    };
  }, [state.status]);

  useEffect(() => {
    const ws = new WebSocket(coopSocketUrl());
    wsRef.current = ws;
    // React 18 StrictMode 在开发环境下会把这个 effect 挂载->清理->再挂载一次,
    // 第一个 socket 的 close 事件如果不判断"是不是当前这个 ws",会在新 socket
    // 已经连上之后把状态错误地打成断线。所以每个回调都要先确认自己还是最新的连接。
    ws.onopen = () => {
      if (wsRef.current === ws) dispatch({ t: 'socket_open' });
    };
    ws.onclose = () => {
      if (wsRef.current === ws) dispatch({ t: 'socket_close' });
    };
    ws.onerror = () => {
      if (wsRef.current === ws) dispatch({ t: 'socket_close' });
    };
    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return;
      try {
        dispatch(JSON.parse(ev.data as string) as S2C);
      } catch {
        // 忽略无法解析的消息
      }
    };
    return () => {
      if (wsRef.current === ws) ws.close();
    };
  }, []);

  function send(msg: C2S): void {
    audio.unlock();
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  if (state.status === 'results' && state.results && state.playerId) {
    return <CoopResults results={state.results} selfId={state.playerId} victory={state.victory} onExit={onExit} />;
  }

  if (state.status === 'battle' && state.config && state.startAt !== null && state.playerId) {
    return (
      <CoopBattle
        selfId={state.playerId}
        players={state.players}
        config={state.config}
        startAt={state.startAt}
        difficulty={state.difficulty}
        bossHp={state.bossHp}
        teamHp={state.teamHp}
        scores={state.scores}
        castWarning={state.castWarning}
        cast={state.cast}
        lastResolvedCastId={state.lastResolvedCastId}
        lastInterruptedBy={state.lastInterruptedBy}
        lastAdvancedWord={state.lastAdvancedWord}
        send={send}
        onExit={onExit}
      />
    );
  }

  const lobbyStatus: 'connecting' | 'lobby' | 'error' = state.status === 'error' ? 'error' : state.status === 'connecting' ? 'connecting' : 'lobby';

  return (
    <Lobby
      status={lobbyStatus}
      code={state.code}
      playerId={state.playerId}
      players={state.players}
      errorMsg={state.errorMsg}
      onCreate={(nick) => send({ t: 'create_room', nick })}
      onJoin={(code, nick) => send({ t: 'join_room', code, nick })}
      onReady={() => send({ t: 'ready' })}
      onStart={(difficulty) => send({ t: 'start', difficulty })}
      onExit={onExit}
    />
  );
}
