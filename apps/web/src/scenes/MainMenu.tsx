import { useEffect, useState } from 'react';
import type { TypingMode, WordEntry } from '@eorzea/shared/types';
import { selectPool } from '@eorzea/shared/wordbank';
import { filterFeaturedWordPool } from '@eorzea/shared/battle';
import { DAILY_CHALLENGE_CONFIG } from '@eorzea/shared/challenge';
import { fetchDailyToday } from '../engine/accountApi';
import { MIN_PRACTICE_WORDS, clearMistakes, mistakeCount, mistakePool } from '../engine/mistakes';
import { loadBank, loadBanks, loadWordbankIndex, type WordbankIndex } from '../data/wordbankLoader';
import { audio } from '../engine/audio';
import { avatarSkinPath, rabbitStylePath } from '../engine/assets';
import { SkinPicker } from '../components/SkinPicker';
import { Leaderboard } from '../components/Leaderboard';
import { CoopLeaderboard } from '../components/CoopLeaderboard';
import { DailyLeaderboard } from '../components/DailyLeaderboard';
import type { Session } from '../engine/accountApi';
import type { SoloVariant } from './SoloBattle';
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

/**
 * 非 FF14 本体的「客串」词库。
 *
 * ★ 这类分类**只能在自定义分类里手动勾选**:快速开始与无限模式用的都是
 *   starter.json,而 starter.json 由 build_wordbank.py 生成、只含 FF14 的分类,
 *   所以客串词库天然进不去那两条路径——不需要额外写排除逻辑,但改动 starter
 *   的生成规则时要留意别把它们卷进去。
 * ★ 列表里染成紫色,让玩家一眼看出「这不是 FF14 的词」。
 */
const GUEST_CATEGORIES: readonly string[] = ['ff7'];

export interface SoloStartConfig {
  pool: WordEntry[];
  mode: TypingMode;
  difficulty: Difficulty;
  inputMode: InputMode;
  character: CharacterId;
  gameMode: GameMode;
  categories: WordEntry['category'][];
  pureOnly: boolean;
  /** 突然死亡模式专用:血量上限压到 1,详见 SoloBattle.tsx 的注释 */
  maxHp?: number;
  /** 强制不计入排行榜 */
  unranked?: boolean;
  /** 玩法变体,决定结算页怎么称呼这一局 */
  variant?: SoloVariant;
  /** 每日挑战:固定 seed + 确定性机制剧本,详见 packages/shared/src/challenge.ts */
  challenge?: { seed: string; dateKey: string };
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
  // 首页只放地狱榜和无限榜(需求 Q27);困难榜、联机组队榜都要单独点开
  const [showHardBoard, setShowHardBoard] = useState(false);
  const [showCoopBoards, setShowCoopBoards] = useState(false);
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
  // 错题本存在 localStorage,每次回到菜单都重新数一遍(刚打完一局可能又多了几个)
  const [mistakes, setMistakes] = useState(() => mistakeCount());
  useEffect(() => { setMistakes(mistakeCount()); }, []);

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

  /**
   * 突然死亡模式:准备给下次比赛用的一次性预设,不受上面的难度/输入模式/
   * 打字模式单选框影响——固定地狱难度的数值(泰坦血量、限时、每次失误的
   * 扣血)、固定拼音模式、固定血量上限 1(见 SoloBattle.tsx 里 maxHp 的注释,
   * 地狱难度下任何一次失误扣血都 ≥1,压到 1 血自然就是「打错就死」,不用
   * 另外发明一套即死判定)。结构复用无限模式(没有狂暴倒计时、泰坦打死一只
   * 立刻刷下一只),但强制 unranked——比赛用的规则和正式排行榜的赛道不是
   * 一回事,不该混进同一份榜单。
   */
  /**
   * 每日挑战:全站当天同一个 seed、同一份机制剧本,配置固定不给选
   * (DAILY_CHALLENGE_CONFIG)。seed 一定要用服务端下发的那个——自己按本地
   * 时区推,时区不对或者机器时间不准就会算出别的 seed,提交时被服务端拒收。
   */
  const startDaily = async () => {
    audio.unlock();
    setBusy(true);
    setError(null);
    try {
      const today = await fetchDailyToday();
      if (!today) {
        setError('拿不到今天的题目,过一会儿再试试。');
        return;
      }
      const bank = await loadBank('starter');
      const pool = filterFeaturedWordPool(selectPool([bank], {
        categories: [...DAILY_CHALLENGE_CONFIG.categories],
        pureOnly: DAILY_CHALLENGE_CONFIG.pureOnly,
      }));
      onStartSolo({
        pool,
        mode: DAILY_CHALLENGE_CONFIG.mode,
        difficulty: DAILY_CHALLENGE_CONFIG.difficulty,
        inputMode: DAILY_CHALLENGE_CONFIG.inputMode,
        character,
        gameMode: DAILY_CHALLENGE_CONFIG.gameMode,
        categories: [...DAILY_CHALLENGE_CONFIG.categories],
        pureOnly: DAILY_CHALLENGE_CONFIG.pureOnly,
        challenge: { seed: today.seed, dateKey: today.dateKey },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 练错题:词池就是错题本里那些词,其余规则沿用玩家当前选的难度/模式。
   *
   * ★ 强制 unranked —— 自定义词池的成绩没法上榜:服务端重放核算要靠
   *   categories + pureOnly 把词池原样重建出来,而错题本是本地攒的,
   *   服务端根本重建不出来,交上去只会被判「词序核对失败」。
   */
  const startMistakePractice = () => {
    audio.unlock();
    setError(null);
    const pool = mistakePool();
    if (pool.length < MIN_PRACTICE_WORDS) {
      setError(`错题本里至少要有 ${MIN_PRACTICE_WORDS} 个词才能开练。`);
      return;
    }
    onStartSolo({
      pool, mode, difficulty, inputMode, character, gameMode: 'standard',
      categories: ['starter'], pureOnly: true, unranked: true, variant: 'mistake_practice',
    });
  };

  const startSuddenDeath = async () => {
    audio.unlock();
    setBusy(true);
    setError(null);
    try {
      const bank = await loadBank('starter');
      const pool = filterFeaturedWordPool(selectPool([bank], { categories: ['starter'], pureOnly: true }));
      onStartSolo({
        pool, mode: 'pinyin', difficulty: 'hell',
        inputMode: resolveInputMode('hell', preferredInputMode),
        character, gameMode: 'endless', categories: ['starter'], pureOnly: true,
        maxHp: 1, unranked: true, variant: 'sudden_death',
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

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
      <p className="menu__subtitle">魔光键影 泰坦绝境战</p>
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
          <div className="menu__coop-group">
            <button className="menu__coop" disabled={busy} onClick={onGoCoop}>
              联机对战(2 人)
            </button>
            {/* 大厅和「联机对战」进的是同一个场景——房间列表就在建房/加入的那一屏上,
                单开一个入口只会让人以为是两个地方 */}
            <button className="menu__coop-teaser" disabled={busy} type="button" onClick={onGoCoop}>
              联机大厅 · 看看谁在等人
            </button>
          </div>
        )}
      </div>

      <button className="menu__endless" disabled={busy} onClick={() => void startSolo('endless')}>
        无限模式 · 困难规则,打到倒下为止
      </button>

      <button className="menu__daily" disabled={busy} onClick={() => void startDaily()}>
        每日挑战 · 全站同一批词,每天零点换,比谁快
      </button>

      <div className="menu__mistakes">
        <span className="menu__mistakes-text">
          错题本 · <strong>{mistakes}</strong> 个词
          {mistakes > 0 && <span className="menu__mistakes-hint">(连着打对 2 次就会自动移走)</span>}
        </span>
        <button
          className="menu__mistakes-btn"
          disabled={busy || mistakes < MIN_PRACTICE_WORDS}
          onClick={startMistakePractice}
        >
          {mistakes < MIN_PRACTICE_WORDS ? `攒够 ${MIN_PRACTICE_WORDS} 个词才能练` : '只练我打错的词'}
        </button>
        {mistakes > 0 && (
          <button
            className="menu__changelog-link"
            onClick={() => { clearMistakes(); setMistakes(0); }}
          >
            清空
          </button>
        )}
      </div>

      <button className="menu__sudden-death" disabled={busy} onClick={() => void startSuddenDeath()}>
        突然死亡模式 · 地狱难度 + 拼音,1 滴血打错就死,不计入排行榜
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
            <label
              key={c.category}
              className={`menu__category-item${
                GUEST_CATEGORIES.includes(c.category) ? ' menu__category-item--guest' : ''}`}
            >
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
        {/* 每日榜放最上面:它一天一换,是最有时效性的那个 */}
        <DailyLeaderboard />
        <Leaderboard gameMode="standard" difficulty="hell" inputMode="composed" />
        <Leaderboard gameMode="endless" difficulty="hard" inputMode="composed" />
        {showHardBoard
          ? <>
              <Leaderboard gameMode="standard" difficulty="hard" inputMode="composed" />
              <button className="menu__changelog-link" onClick={() => setShowHardBoard(false)}>
                收起困难难度排行榜
              </button>
            </>
          : <button className="menu__changelog-link" onClick={() => setShowHardBoard(true)}>
              查看困难难度排行榜
            </button>}
        {coopAvailable && (
          <div className="menu-layout__coop-boards">
            {showCoopBoards
              ? <>
                  <CoopLeaderboard gameMode="standard" difficulty="hell" inputMode="composed" />
                  <CoopLeaderboard gameMode="endless" difficulty="hard" inputMode="composed" />
                  <button className="menu__changelog-link" onClick={() => setShowCoopBoards(false)}>
                    收起联机组队排行榜
                  </button>
                </>
              : <button className="menu__changelog-link" onClick={() => setShowCoopBoards(true)}>
                  查看联机组队排行榜
                </button>}
          </div>
        )}
      </aside>
    </div>
  );
}
