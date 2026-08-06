import { useEffect, useState } from 'react';
import type { TypingMode, WordEntry } from '@eorzea/shared/types';
import { selectPool } from '@eorzea/shared/wordbank';
import { filterFeaturedWordPool } from '@eorzea/shared/battle';
import { loadBank, loadBanks, loadWordbankIndex, type WordbankIndex } from '../data/wordbankLoader';
import { audio } from '../engine/audio';
import { avatarSkinPath, rabbitStylePath } from '../engine/assets';
import { SkinPicker } from '../components/SkinPicker';
import { Leaderboard } from '../components/Leaderboard';
import type { Session } from '../engine/accountApi';
import {
  CHARACTER_LABEL,
  DEFAULT_INPUT_MODE,
  ENDLESS_DIFFICULTY,
  DIFFICULTY_LABEL,
  INPUT_MODE_HINT,
  INPUT_MODE_LABEL,
  SKILLS,
  allowsComposedInput,
  resolveInputMode,
  type CharacterId,
  type Difficulty,
  type GameMode,
  type InputMode,
} from '../battle/constants';

export interface SoloStartConfig {
  pool: WordEntry[];
  mode: TypingMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  gameMode: GameMode;
  categories: WordEntry['category'][];
  pureOnly: boolean;
}

export interface MainMenuProps {
  onStartSolo: (config: SoloStartConfig) => void;
  onGoCoop: () => void;
  victoryCount: number;
  /** 移动端不提供联机,入口整块藏掉而不是给个点了没反应的按钮 */
  coopAvailable: boolean;
  onShowChangelog: () => void;
  onGoAccount: () => void;
  session: Session | null;
}

export function MainMenu({ onStartSolo, onGoCoop, victoryCount, coopAvailable, onShowChangelog, onGoAccount, session }: MainMenuProps) {
  // 首页只放地狱榜和无限榜(需求 Q27);困难榜要单独点开
  const [showHardBoard, setShowHardBoard] = useState(false);
  const [index, setIndex] = useState<WordbankIndex | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<TypingMode>('hanzi');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  // 玩家的偏好原样留着,不因为切到地狱就被改掉;真正生效的值由 resolveInputMode
  // 按难度收敛(地狱恒为逐字),这样从地狱切回普通时还能拿回原来的选择。
  const [preferredInputMode, setPreferredInputMode] = useState<InputMode>(DEFAULT_INPUT_MODE);
  const [character, setCharacter] = useState<CharacterId>('p1');
  const inputMode = resolveInputMode(difficulty, preferredInputMode);
  const composedAllowed = allowsComposedInput(difficulty);
  // 默认只用纯汉字词条(体验更好);打开后能遇到「扇舞·序」这类带标点的技能名,
  // 界面显示原文、判定用 typeText —— 更有 FF14 味道,但输入法下更难打
  const [includeImpure, setIncludeImpure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadWordbankIndex().then(setIndex).catch((e) => setError(String(e)));
  }, []);

  const toggle = (category: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  /**
   * 起一局单机。无限模式固定用困难难度(ENDLESS_DIFFICULTY)——排行榜要可比,
   * 不能让人挑简单难度刷时长;输入模式仍然尊重玩家的选择,只是会被记进成绩里。
   */
  const startSolo = async (gameMode: GameMode) => {
    audio.unlock(); // 必须在用户点击这一刻同步调用,否则整局无声
    setBusy(true);
    setError(null);
    try {
      const bank = await loadBank('starter');
      const pool = filterFeaturedWordPool(selectPool([bank], { categories: ['starter'], pureOnly: true }));
      const d = gameMode === 'endless' ? ENDLESS_DIFFICULTY : difficulty;
      onStartSolo({ pool, mode, difficulty: d, inputMode: resolveInputMode(d, preferredInputMode), character, gameMode,
        categories: ['starter'], pureOnly: true });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const startQuick = () => startSolo('standard');

  const startCustom = async () => {
    if (selected.size === 0) return;
    audio.unlock();
    setBusy(true);
    setError(null);
    try {
      const categories = [...selected] as WordEntry['category'][];
      const banks = await loadBanks(categories);
      const pool = filterFeaturedWordPool(selectPool(banks, { categories, pureOnly: !includeImpure }));
      if (pool.length === 0) {
        setError('所选分类里没有可用的纯汉字词条,换一批分类试试。');
        return;
      }
      onStartSolo({ pool, mode, difficulty, inputMode, character, gameMode: 'standard',
        categories, pureOnly: !includeImpure });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="menu-layout">
      <div className="menu">
      <img className="menu__title" src="/assets/logo-title.png" alt="最终幻想14打字通" />
      <p className="menu__subtitle">键入词条,打倒泰坦</p>
      <div className="menu__record">本次记录 · 通关次数 <strong>{victoryCount}</strong></div>
      <div className="menu__account">
        {session
          ? <><span className="menu__account-id">{session.displayId}</span>
              <button className="menu__changelog-link" onClick={onGoAccount}>账号</button></>
          : <><span className="menu__account-id">未登录 · 成绩无法上榜</span>
              <button className="menu__changelog-link" onClick={onGoAccount}>申请 / 登录</button></>}
      </div>

      <div className="menu__community">
        玩家群 · <strong>143232747</strong>
        <button className="menu__changelog-link" type="button" onClick={onShowChangelog}>
          更新说明
        </button>
      </div>

      <div className="menu__mode">
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'hanzi'}
            onChange={() => setMode('hanzi')}
          />
          汉字模式
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'pinyin'}
            onChange={() => setMode('pinyin')}
          />
          拼音模式
        </label>
      </div>

      <div className="menu__mode">
        {(Object.keys(DIFFICULTY_LABEL) as Difficulty[]).map((d) => (
          <label key={d}>
            <input
              type="radio"
              name="difficulty"
              checked={difficulty === d}
              onChange={() => setDifficulty(d)}
            />
            {DIFFICULTY_LABEL[d]}
          </label>
        ))}
      </div>

      <div className="menu__mode menu__mode--input">
        {(Object.keys(INPUT_MODE_LABEL) as InputMode[]).map((m) => {
          const locked = m === 'composed' && !composedAllowed;
          return (
            <label key={m} className={locked ? 'menu__option--locked' : undefined}>
              <input
                type="radio"
                name="input-mode"
                checked={inputMode === m}
                disabled={locked}
                onChange={() => setPreferredInputMode(m)}
              />
              {INPUT_MODE_LABEL[m]}
            </label>
          );
        })}
        <span className="menu__mode-hint">
          {composedAllowed
            ? INPUT_MODE_HINT[inputMode]
            : '地狱难度只有逐字输入 —— 那一档的规则就是打错一个字立刻判负'}
        </span>
      </div>

      <div className="menu__characters">
        <div className="menu__categories-title">出战角色</div>
        {(Object.keys(CHARACTER_LABEL) as CharacterId[]).map((c) => (
          <label key={c} className="menu__character-item">
            <input
              type="radio"
              name="character"
              checked={character === c}
              onChange={() => setCharacter(c)}
            />
            <img className="menu__character-art" src={avatarSkinPath(c, 1)} alt="" aria-hidden="true" />
            <span className="menu__character-text">
              <strong>{CHARACTER_LABEL[c]}</strong>
              <span className="menu__character-skill">{SKILLS[c].name} · {SKILLS[c].description}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="menu__start-row">
        <button className="menu__quick-start" disabled={busy} onClick={startQuick}>
          快速开始(艾欧泽亚特色词库)
        </button>
        {coopAvailable && (
          <button className="menu__coop" disabled={busy} onClick={onGoCoop}>
            联机对战(2 人)
          </button>
        )}
      </div>

      <button className="menu__endless" disabled={busy} onClick={() => void startSolo('endless')}>
        无限模式 · 困难规则,打到倒下为止
      </button>

      <div className="menu__appearance">
        <SkinPicker label="你的皮肤" slot="p1" pathFor={(i) => avatarSkinPath('p1', i)} />
        <SkinPicker label="队友皮肤" slot="p2" pathFor={(i) => avatarSkinPath('p2', i)} />
        <SkinPicker label="打错提示" slot="rabbit" pathFor={rabbitStylePath} />
      </div>

      <div className="menu__categories">
        <div className="menu__categories-title">自定义分类</div>
        <label className="menu__category-item">
          <input
            type="checkbox"
            checked={includeImpure}
            onChange={(ev) => setIncludeImpure(ev.target.checked)}
          />
          包含带标点/数字的词条(如「扇舞·序」,更难)
        </label>
        {!index && <div className="menu__loading">词库索引加载中…</div>}
        <div className="menu__category-grid">
          {index?.categories.map((c) => (
            <label key={c.category} className="menu__category-item">
              <input
                type="checkbox"
                checked={selected.has(c.category)}
                onChange={() => toggle(c.category)}
              />
              {c.label}
              <span className="menu__category-count">{c.count}</span>
            </label>
          ))}
        </div>
        <button className="menu__custom-start" disabled={busy || selected.size === 0} onClick={startCustom}>
          用所选分类开始
        </button>
      </div>

      {error && <div className="menu__error">{error}</div>}
      </div>

      {/*
        排行榜独立成右栏,sticky 跟随滚动 —— 菜单本身很长,榜单钉住之后
        滑到底部选分类时也还看得见自己排第几。窄屏由媒体查询叠回单列。
      */}
      <aside className="menu-layout__boards">
        <Leaderboard gameMode="standard" difficulty="hell" inputMode="composed" />
        <Leaderboard gameMode="endless" difficulty="hard" inputMode="composed" />
        {showHardBoard
          ? <Leaderboard gameMode="standard" difficulty="hard" inputMode="composed" />
          : <button className="menu__changelog-link" onClick={() => setShowHardBoard(true)}>
              查看困难难度排行榜
            </button>}
      </aside>
    </div>
  );
}
