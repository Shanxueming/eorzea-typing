import { useEffect, useState } from 'react';
import type { SkillDef } from '@eorzea/shared/battle';

export interface SkillButtonProps {
  skill: SkillDef;
  /** 技能可用的时刻(相对本局毫秒) */
  readyAt: number;
  /** 返回当前的相对本局毫秒数,和战斗场景用同一个时钟 */
  now: () => number;
  disabled: boolean;
  onUse: () => void;
}

/**
 * 技能按钮 + 冷却读秒。
 *
 * 冷却是靠自己的 250ms 计时器刷新的,不依赖战斗场景 rerender —— 战斗场景的
 * rerender 由 100ms 的 tick 驱动,看着够用,但打断期间某些分支会提前 return,
 * 冷却数字就会卡住不动。自己转一个计时器最省心,代价只有每秒四次的重绘。
 */
export function SkillButton({ skill, readyAt, now, disabled, onUse }: SkillButtonProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  const remainingMs = Math.max(0, readyAt - now());
  const onCooldown = remainingMs > 0;

  return (
    <button
      type="button"
      className={`skill-button${onCooldown ? ' skill-button--cooling' : ''}`}
      disabled={disabled || onCooldown}
      onClick={onUse}
      title={skill.description}
    >
      <span className="skill-button__name">{skill.name}</span>
      <span className="skill-button__state">
        {onCooldown ? `${Math.ceil(remainingMs / 1000)}s` : '可用'}
      </span>
    </button>
  );
}
