import { MECHANICS, type MechanicState } from '@eorzea/shared/mechanics';

export interface MechanicPanelProps {
  state: MechanicState;
  /** 剩余毫秒,由战斗场景的 tick 驱动 */
  remainingMs: number;
  totalMs: number;
  /** 队友那一份:只画机制本身,不重复显示名字与倒计时 */
  compact?: boolean;
}

/**
 * 机制的专属展示区。
 *
 * ★ 加新机制时只需要在这里多一个分支 —— 战斗场景不认识任何具体机制,
 *   它只管把 MechanicState 丢进来(见 packages/shared/src/mechanics.ts 顶部说明)。
 *   要打的词由 TypingField 统一展示,这里只画「机制本身的样子」:
 *   三连桶画赛道,三穿一画顺序。
 */
export function MechanicPanel({ state, remainingMs, totalMs, compact }: MechanicPanelProps) {
  const def = MECHANICS[state.id];
  const pct = totalMs > 0 ? Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)) : 0;

  if (compact) {
    return (
      <div className="mechanic mechanic--compact">
        {state.barrel && <BarrelLane state={state} />}
        {state.pierce && <PierceOrder state={state} />}
      </div>
    );
  }

  return (
    <div className="mechanic">
      <div className="mechanic__header">
        <span className="mechanic__name">{def.name}</span>
        <span className="mechanic__hint">{def.hint}</span>
        <span className="mechanic__timer">{(remainingMs / 1000).toFixed(1)}s</span>
      </div>
      <div className="mechanic__track">
        <div className="mechanic__track-fill" style={{ width: `${pct}%` }} />
      </div>

      {state.barrel && <BarrelLane state={state} />}
      {state.pierce && <PierceOrder state={state} />}
    </div>
  );
}

/** 三连桶:一条赛道,玩家在某一格,石头在正中,走到石头后面才算躲开 */
function BarrelLane({ state }: { state: MechanicState }) {
  const b = state.barrel!;
  const cells = Array.from({ length: b.laneSize }, (_, i) => i);
  const dirNeeded = b.position < b.stoneIndex ? '右' : '左';

  return (
    <div className="barrel">
      <div className="barrel__lane">
        {cells.map((i) => {
          const isStone = i === b.stoneIndex;
          const isSelf = i === b.position;
          return (
            <div
              key={i}
              className={`barrel__cell${isStone ? ' barrel__cell--stone' : ''}${isSelf ? ' barrel__cell--self' : ''}`}
            >
              {isSelf ? '🐈' : isStone ? '🪨' : ''}
            </div>
          );
        })}
      </div>
      <div className="barrel__legend">
        往<strong>{dirNeeded}</strong>走 · 「{b.leftWord.text}」= 左，「{b.rightWord.text}」= 右
        <span className="barrel__note">打错方向的词只是原地不动,不会倒退</span>
      </div>
    </div>
  );
}

/** 三穿一:三个词带序号,按序号依次打,已完成的置灰 */
function PierceOrder({ state }: { state: MechanicState }) {
  const p = state.pierce!;
  return (
    <div className="pierce">
      {p.order.map((wordIndex, step) => {
        const w = p.words[wordIndex];
        const done = step < p.solved;
        const current = step === p.solved;
        return (
          <div
            key={w.id}
            className={`pierce__item${done ? ' pierce__item--done' : ''}${current ? ' pierce__item--current' : ''}`}
          >
            <span className="pierce__index">{step + 1}</span>
            <span className="pierce__word">{w.text}</span>
          </div>
        );
      })}
    </div>
  );
}
