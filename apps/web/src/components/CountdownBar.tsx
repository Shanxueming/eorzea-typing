export interface CountdownBarProps {
  label: string;
  remainingMs: number;
  totalMs: number;
  variant: 'enrage' | 'word';
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 统一呈现整局狂暴与当前普通词的倒计时，数值和长度都来自同一个毫秒来源。 */
export function CountdownBar({ label, remainingMs, totalMs, variant }: CountdownBarProps) {
  const percent = totalMs > 0 ? Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)) : 0;
  return (
    <div className={`countdown-bar countdown-bar--${variant}`}>
      <div className="countdown-bar__label">
        <span>{label}</span>
        <strong>{formatTime(remainingMs)}</strong>
      </div>
      <div className="countdown-bar__track">
        <div className="countdown-bar__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
