import { useMemo, useState } from 'react';
import type { WordEntry } from '@eorzea/shared/types';
import { PLAYER_MAX_HP } from '@eorzea/shared/battle';
import {
  TOWER_FLOORS, TOWER_ROUTES, buildTowerFloor, routeChoicesFor,
  type TowerFloor, type TowerRouteId,
} from '@eorzea/shared/tower';
import { SoloBattle, type SoloResult } from './SoloBattle';

export interface TowerSceneProps {
  /** 完整词池(未按难度筛),每层再按自己的词长区间筛 */
  pool: WordEntry[];
  onExit: () => void;
}

/**
 * ★ 「正在打哪一层」只存 (层号, 路),不存整份 TowerFloor —— 配置永远由
 *   buildTowerFloor(runSeed, ...) 现算。存快照的话 runSeed 变了(重开一轮)
 *   而快照没变,就会出现「新的一轮却在打上一座塔的楼层」这种对不上的状态。
 */
type Phase =
  | { kind: 'floor'; floorNum: number; route: TowerRouteId }
  /** 刚过一层,正在选下一条路 */
  | { kind: 'choose'; nextFloor: number; choices: TowerRouteId[] }
  | { kind: 'over'; reachedFloor: number; cleared: boolean };

/** 第一层固定走疾风道:开局先给个短平快的,让人先摸到手感 */
const FIRST_ROUTE: TowerRouteId = 'swift';

/** 一轮爬塔的种子。同一个 seed = 同一座塔(楼层与岔路都由它推出来) */
function newRunSeed(): string {
  return `tower-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 爬塔:100 层,一层一次小遭遇,清完选一条岔路继续。血量跨层继承,倒下这轮就结束。
 *
 * ★ 每一层直接复用 SoloBattle —— 靠 clearAfterWords(打对几个词算过)和
 *   startHp(把上一层剩的血带进来)两个参数,不另写一套战斗逻辑。
 * ★ 每层用不同的 key 强制 SoloBattle 重新挂载:它的战斗状态全在 useRef 里,
 *   不换 key 的话换层不会重置,血量/词队列会串到下一层去。
 */
export function TowerScene({ pool, onExit }: TowerSceneProps) {
  const [runSeed, setRunSeed] = useState(newRunSeed);
  const [hp, setHp] = useState(PLAYER_MAX_HP);
  const [phase, setPhase] = useState<Phase>({ kind: 'floor', floorNum: 1, route: FIRST_ROUTE });
  /** 换层要换 SoloBattle 的 key,理由见组件注释 */
  const [battleKey, setBattleKey] = useState(0);

  const currentFloor = phase.kind === 'floor'
    ? buildTowerFloor(runSeed, phase.floorNum, phase.route)
    : null;

  /** 这一层实际能用的词池:按该层的词长区间筛 */
  const floorPool = useMemo(() => {
    if (!currentFloor) return pool;
    const [min, max] = currentFloor.wordLength;
    const filtered = pool.filter((w) => w.typeText.length >= min && w.typeText.length <= max);
    // 筛空了就退回整池 —— 宁可这一层的词长不生效,也不能让塔卡在这里开不了局
    return filtered.length > 0 ? filtered : pool;
  }, [pool, currentFloor?.floor, currentFloor?.route]);

  const restart = () => {
    setRunSeed(newRunSeed());
    setHp(PLAYER_MAX_HP);
    setPhase({ kind: 'floor', floorNum: 1, route: FIRST_ROUTE });
    setBattleKey((k) => k + 1);
  };

  const onFloorFinish = (result: SoloResult) => {
    if (!currentFloor) return;
    // 过了这一层就按该层规则回一点血(静室/精英才有),再夹回上限
    const healed = result.victory
      ? Math.min(PLAYER_MAX_HP, result.playerHp + currentFloor.healOnClear)
      : result.playerHp;
    setHp(healed);

    if (!result.victory) {
      setPhase({ kind: 'over', reachedFloor: currentFloor.floor, cleared: false });
      return;
    }
    if (currentFloor.floor >= TOWER_FLOORS) {
      setPhase({ kind: 'over', reachedFloor: TOWER_FLOORS, cleared: true });
      return;
    }
    const nextFloor = currentFloor.floor + 1;
    setPhase({ kind: 'choose', nextFloor, choices: routeChoicesFor(runSeed, nextFloor) });
  };

  const pickRoute = (route: TowerRouteId) => {
    if (phase.kind !== 'choose') return;
    setPhase({ kind: 'floor', floorNum: phase.nextFloor, route });
    setBattleKey((k) => k + 1);
  };

  // ── 选路 ──
  if (phase.kind === 'choose') {
    return (
      <div className="tower">
        <h1 className="tower__title">第 {phase.nextFloor} 层 · 选一条路</h1>
        <div className="tower__hp">当前血量 {hp} / {PLAYER_MAX_HP}</div>
        <div className="tower__routes">
          {phase.choices.map((id) => {
            const def = TOWER_ROUTES[id];
            const preview = buildTowerFloor(runSeed, phase.nextFloor, id);
            return (
              <button key={id} className="tower__route" onClick={() => pickRoute(id)}>
                <span className="tower__route-name">{def.name}</span>
                <span className="tower__route-blurb">{def.blurb}</span>
                <span className="tower__route-stats">
                  {preview.words} 词 · 每词 {(preview.wordTimeoutMs / 1000).toFixed(1)}s · 失手 -{preview.damageOnMiss}
                  {preview.healOnClear > 0 && ` · 过关 +${preview.healOnClear}`}
                </span>
              </button>
            );
          })}
        </div>
        <button className="tower__exit" onClick={onExit}>放弃这轮,返回主菜单</button>
      </div>
    );
  }

  // ── 结束 ──
  if (phase.kind === 'over') {
    return (
      <div className="tower">
        <h1 className="tower__title">
          {phase.cleared ? `登顶！${TOWER_FLOORS} 层全通` : `倒在第 ${phase.reachedFloor} 层`}
        </h1>
        <div className="tower__hp">
          {phase.cleared ? '这座塔被你打穿了。' : `再来一轮会是一座全新的塔(每轮的岔路都不一样)。`}
        </div>
        <div className="tower__over-actions">
          <button onClick={restart}>再爬一轮</button>
          <button onClick={onExit}>返回主菜单</button>
        </div>
      </div>
    );
  }

  // ── 打这一层 ──
  const floor = currentFloor as TowerFloor;
  return (
    <div className="tower-battle">
      <div className="tower-battle__banner">
        第 <strong>{floor.floor}</strong> / {TOWER_FLOORS} 层
        {floor.isBoss && <span className="tower-battle__boss">BOSS</span>}
        <span className="tower-battle__route">{TOWER_ROUTES[floor.route].name}</span>
        <span className="tower-battle__goal">打对 {floor.words} 个词过关</span>
      </div>
      <SoloBattle
        key={battleKey}
        pool={floorPool}
        mode={floor.mode}
        difficulty={floor.difficulty}
        inputMode={floor.inputMode}
        character="p1"
        gameMode="standard"
        categories={['starter']}
        pureOnly
        startHp={hp}
        clearAfterWords={floor.words}
        wordTimeoutMsOverride={floor.wordTimeoutMs}
        damageOnMissOverride={floor.damageOnMiss}
        // 机制只在 Boss 层出现,理由见 SoloBattle 的 enableMechanics 注释
        enableMechanics={floor.isBoss}
        unranked
        onFinish={onFloorFinish}
        onExit={onExit}
      />
    </div>
  );
}
