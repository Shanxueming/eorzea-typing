import { useEffect, useState } from 'react';
import type { PlayerPublic } from '../engine/coopProtocol';
import { fetchOpenRooms, type OpenRoom } from '../engine/accountApi';
import {
  CHARACTER_LABEL,
  SKILLS,
  DEFAULT_INPUT_MODE,
  DIFFICULTY_LABEL,
  INPUT_MODE_LABEL,
  allowsComposedInput,
  resolveInputMode,
  ENDLESS_DIFFICULTY,
  type CharacterId,
  type Difficulty,
  type GameMode,
  type InputMode,
} from '../battle/constants';
import { avatarSkinPath } from '../engine/assets';

export interface LobbyProps {
  status: 'connecting' | 'lobby' | 'error';
  code: string | null;
  playerId: string | null;
  players: PlayerPublic[];
  errorMsg: string | null;
  onCreate: (nick: string, isPublic: boolean) => void;
  onJoin: (code: string, nick: string) => void;
  onReady: () => void;
  onStart: (difficulty: Difficulty, inputMode: InputMode, gameMode: GameMode, submitScore: boolean) => void;
  onSelectCharacter: (character: CharacterId) => void;
  onExit: () => void;
}

/** 大厅房间列表的刷新间隔。房间开开关关不算频繁,10 秒足够 */
const LOBBY_POLL_INTERVAL_MS = 10_000;

/** 「刚刚 / 3 分钟前」——房间列表里让人一眼看出这房挂了多久 */
function openedAgo(createdAt: number): string {
  const mins = Math.floor((Date.now() - createdAt) / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  return `${Math.floor(mins / 60)} 小时前`;
}

/**
 * 房主流程:房主没有「准备」按钮,只有「开始」——单人不能点,凑够 2 人后
 * 房主选难度、等非房主那位点了准备,房主再点开始,这局就用房主选的难度。
 */
export function Lobby({ status, code, playerId, players, errorMsg, onCreate, onJoin, onReady, onStart, onSelectCharacter, onExit }: LobbyProps) {
  const [nick, setNick] = useState(() => localStorage.getItem('eorzea-nick') ?? '');
  const [joinCode, setJoinCode] = useState('');
  /** 开的房要不要挂到大厅列表上。默认公开——大厅要有房间才有意义 */
  const [isPublic, setIsPublic] = useState(true);
  const [openRooms, setOpenRooms] = useState<OpenRoom[] | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [preferredInputMode, setPreferredInputMode] = useState<InputMode>(DEFAULT_INPUT_MODE);
  const [gameMode, setGameMode] = useState<GameMode>('standard');
  const [submitScore, setSubmitScore] = useState(false);
  // 两个人必须同一套判负规则,所以输入模式和难度一样由房主定;地狱强制逐字。
  // 无限模式难度固定困难,不给选。
  const effectiveDifficulty = gameMode === 'endless' ? ENDLESS_DIFFICULTY : difficulty;
  const inputMode = resolveInputMode(effectiveDifficulty, preferredInputMode);

  const persistNick = (v: string) => {
    setNick(v);
    localStorage.setItem('eorzea-nick', v);
  };

  /**
   * 大厅房间列表:进了房就不用再拉了(`code` 非空即已在房内)。
   * 轮询而不是走 WebSocket 推送——房间列表变化不频繁,而且这个页面还没有
   * 建立房间连接,为了列表单开一条长连接不划算。
   */
  const inRoom = !!code;
  useEffect(() => {
    if (inRoom) return;
    let alive = true;
    const pull = () => { void fetchOpenRooms().then((r) => { if (alive) setOpenRooms(r); }); };
    pull();
    const timer = setInterval(pull, LOBBY_POLL_INTERVAL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [inRoom]);

  const self = players.find((p) => p.playerId === playerId);
  const isHost = !!self?.isHost;
  const guest = players.find((p) => !p.isHost);
  // 团队榜要求双方都登录——少一个都不行,半计没有意义
  const bothLoggedIn = players.length === 2 && players.every((p) => !!p.displayId);

  if (!code) {
    return (
      <div className="lobby">
        <h1>联机对战</h1>
        <p>2 人组队,共打泰坦。</p>
        {status === 'connecting' && <div>正在连接服务器…</div>}
        <input
          className="lobby__input"
          placeholder="你的昵称"
          value={nick}
          maxLength={16}
          onChange={(ev) => persistNick(ev.target.value)}
        />
        <button disabled={status !== 'lobby' || !nick.trim()} onClick={() => onCreate(nick.trim(), isPublic)}>
          创建房间
        </button>
        <label className="lobby__visibility">
          <input type="checkbox" checked={isPublic} onChange={(ev) => setIsPublic(ev.target.checked)} />
          挂到大厅让别人能看到(取消勾选就只能靠房间码进)
        </label>
        <div className="lobby__row">
          <input
            className="lobby__input"
            placeholder="房间码"
            value={joinCode}
            maxLength={6}
            onChange={(ev) => setJoinCode(ev.target.value.toUpperCase())}
          />
          <button
            disabled={status !== 'lobby' || !nick.trim() || joinCode.length !== 6}
            onClick={() => onJoin(joinCode, nick.trim())}
          >
            加入房间
          </button>
        </div>

        <div className="lobby__rooms">
          <div className="lobby__rooms-title">
            联机大厅 · 正在等人的房间
            {openRooms !== null && <span className="lobby__rooms-count">{openRooms.length}</span>}
          </div>
          {openRooms === null && <div className="lobby__rooms-empty">读取中…</div>}
          {openRooms?.length === 0 && (
            <div className="lobby__rooms-empty">
              现在没有公开房间。你可以自己开一间等人来,或者把房间码发给朋友。
            </div>
          )}
          {openRooms && openRooms.length > 0 && (
            <ul className="lobby__rooms-list">
              {openRooms.map((room) => (
                <li key={room.code} className="lobby__rooms-row">
                  <span className="lobby__rooms-host">{room.hostNick}</span>
                  <span className="lobby__rooms-meta">
                    {room.code} · {room.playerCount}/2 · {openedAgo(room.createdAt)}
                  </span>
                  <button
                    disabled={status !== 'lobby' || !nick.trim()}
                    onClick={() => onJoin(room.code, nick.trim())}
                  >
                    加入
                  </button>
                </li>
              ))}
            </ul>
          )}
          {openRooms && openRooms.length > 0 && !nick.trim() && (
            <div className="lobby__rooms-empty">先在上面填个昵称,才能加入房间。</div>
          )}
        </div>

        {errorMsg && <div className="menu__error">{errorMsg}</div>}
        <button onClick={onExit}>返回主菜单</button>
      </div>
    );
  }

  let startLabel = '等待队友加入';
  if (players.length === 2) startLabel = guest?.ready ? '开始游戏' : '等待队友准备';
  const canStart = isHost && players.length === 2 && !!guest?.ready;

  return (
    <div className="lobby">
      <h1>
        房间 <span className="lobby__code">{code}</span>
      </h1>
      <p>把房间码发给队友,{isHost ? '队友准备好之后你来选难度、点开始。' : '等房主选好难度开始。'}</p>
      <ul className="party-list__players">
        {players.map((p) => (
          <li key={p.playerId} className="party-list__row">
            <span>
              {p.nick}
              {p.playerId === playerId ? '(你)' : ''}
              {p.isHost ? ' · 房主' : ''}
              <span className="lobby__character"> · {CHARACTER_LABEL[p.character]}</span>
              {p.displayId
                ? <span className="lobby__account"> · 已登录 {p.displayId}</span>
                : <span className="lobby__account lobby__account--guest"> · 未登录</span>}
            </span>
            <span>{p.isHost ? '' : p.ready ? '已准备' : '未准备'}</span>
          </li>
        ))}
      </ul>

      <div className="menu__characters">
        <div className="menu__categories-title">出战角色(两人可以选同一个)</div>
        {(Object.keys(CHARACTER_LABEL) as CharacterId[]).map((c) => (
          <label key={c} className="menu__character-item">
            <input
              type="radio"
              name="coop-character"
              checked={self?.character === c}
              onChange={() => onSelectCharacter(c)}
            />
            <img className="menu__character-art" src={avatarSkinPath(c, 1)} alt="" aria-hidden="true" />
            <span className="menu__character-text">
              <strong>{CHARACTER_LABEL[c]}</strong>
              <span className="menu__character-skill">{SKILLS[c].name} · {SKILLS[c].description}</span>
            </span>
          </label>
        ))}
      </div>

      {isHost && players.length === 2 && (
        <>
          <div className="menu__mode">
            <label>
              <input
                type="radio"
                name="coop-game-mode"
                checked={gameMode === 'standard'}
                onChange={() => setGameMode('standard')}
              />
              标准模式
            </label>
            <label>
              <input
                type="radio"
                name="coop-game-mode"
                checked={gameMode === 'endless'}
                onChange={() => setGameMode('endless')}
              />
              无限模式(困难规则,打到团队血量归零为止)
            </label>
          </div>
          {gameMode === 'standard' && (
            <div className="menu__mode">
              {/* 练习难度只在单机开放:服务端联机难度校验表没收它,选了也会被拒绝(见
                  packages/shared/src/battle.ts 里 Difficulty 类型上的说明) */}
              {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).filter((d) => d !== 'practice').map((d) => (
                <label key={d}>
                  <input
                    type="radio"
                    name="coop-difficulty"
                    checked={difficulty === d}
                    onChange={() => setDifficulty(d)}
                  />
                  {DIFFICULTY_LABEL[d]}
                </label>
              ))}
            </div>
          )}
          <div className="menu__mode menu__mode--input">
            {(Object.keys(INPUT_MODE_LABEL) as InputMode[]).map((m) => {
              const locked = m === 'composed' && !allowsComposedInput(effectiveDifficulty);
              return (
                <label key={m} className={locked ? 'menu__option--locked' : undefined}>
                  <input
                    type="radio"
                    name="coop-input-mode"
                    checked={inputMode === m}
                    disabled={locked}
                    onChange={() => setPreferredInputMode(m)}
                  />
                  {INPUT_MODE_LABEL[m]}
                </label>
              );
            })}
            <span className="menu__mode-hint">两人共用房主选的这套规则</span>
          </div>
          <label className={`menu__submit-score${bothLoggedIn ? '' : ' menu__option--locked'}`}>
            <input
              type="checkbox"
              checked={submitScore}
              disabled={!bothLoggedIn}
              onChange={(ev) => setSubmitScore(ev.target.checked)}
            />
            上传成绩到排行榜(团队榜,两个名字绑一起显示)
            {!bothLoggedIn && <span className="menu__mode-hint"> —— 需要两人都登录才能勾选</span>}
          </label>
        </>
      )}

      {isHost ? (
        <button disabled={!canStart} onClick={() => onStart(difficulty, inputMode, gameMode, submitScore)}>
          {startLabel}
        </button>
      ) : (
        <button disabled={self?.ready} onClick={onReady}>
          {self?.ready ? '等待房主开始…' : '准备'}
        </button>
      )}

      {errorMsg && <div className="menu__error">{errorMsg}</div>}
      <button onClick={onExit}>离开房间</button>
    </div>
  );
}
