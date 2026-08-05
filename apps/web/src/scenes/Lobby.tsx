import { useState } from 'react';
import type { PlayerPublic } from '../engine/coopProtocol';
import {
  CHARACTER_LABEL,
  SKILLS,
  DEFAULT_INPUT_MODE,
  DIFFICULTY_LABEL,
  INPUT_MODE_LABEL,
  allowsComposedInput,
  resolveInputMode,
  type CharacterId,
  type Difficulty,
  type InputMode,
} from '../battle/constants';
import { avatarSkinPath } from '../engine/assets';

export interface LobbyProps {
  status: 'connecting' | 'lobby' | 'error';
  code: string | null;
  playerId: string | null;
  players: PlayerPublic[];
  errorMsg: string | null;
  onCreate: (nick: string) => void;
  onJoin: (code: string, nick: string) => void;
  onReady: () => void;
  onStart: (difficulty: Difficulty, inputMode: InputMode) => void;
  onSelectCharacter: (character: CharacterId) => void;
  onExit: () => void;
}

/**
 * 房主流程:房主没有「准备」按钮,只有「开始」——单人不能点,凑够 2 人后
 * 房主选难度、等非房主那位点了准备,房主再点开始,这局就用房主选的难度。
 */
export function Lobby({ status, code, playerId, players, errorMsg, onCreate, onJoin, onReady, onStart, onSelectCharacter, onExit }: LobbyProps) {
  const [nick, setNick] = useState(() => localStorage.getItem('eorzea-nick') ?? '');
  const [joinCode, setJoinCode] = useState('');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [preferredInputMode, setPreferredInputMode] = useState<InputMode>(DEFAULT_INPUT_MODE);
  // 两个人必须同一套判负规则,所以输入模式和难度一样由房主定;地狱强制逐字
  const inputMode = resolveInputMode(difficulty, preferredInputMode);

  const persistNick = (v: string) => {
    setNick(v);
    localStorage.setItem('eorzea-nick', v);
  };

  const self = players.find((p) => p.playerId === playerId);
  const isHost = !!self?.isHost;
  const guest = players.find((p) => !p.isHost);

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
        <button disabled={status !== 'lobby' || !nick.trim()} onClick={() => onCreate(nick.trim())}>
          创建房间
        </button>
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
            {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => (
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
          <div className="menu__mode menu__mode--input">
            {(Object.keys(INPUT_MODE_LABEL) as InputMode[]).map((m) => {
              const locked = m === 'composed' && !allowsComposedInput(difficulty);
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
        </>
      )}

      {isHost ? (
        <button disabled={!canStart} onClick={() => onStart(difficulty, inputMode)}>
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
