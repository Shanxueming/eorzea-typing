export interface HpBarProps {
  value: number;
  max: number;
  variant: 'boss' | 'player';
}

export function HpBar({ value, max, variant }: HpBarProps) {
  const clamped = Math.max(0, Math.min(max, value));
  const pct = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div className={`hpbar hpbar--${variant}`}>
      <div className="hpbar__track">
        <div className="hpbar__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="hpbar__label">
        {Math.round(clamped)} / {max}
      </div>
    </div>
  );
}
