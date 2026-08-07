import { useEffect, useState } from 'react';

/** 每隔 intervalMs 返回一次当前时间戳,给需要跟着走的倒计时用 */
export function useTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 毫秒转成"X 天 X 小时" / "X 小时 X 分" / "X 分钟"的粗粒度倒计时文案 */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

/** 时间段起止的日期标签,给历史榜单用,如「8/1 08:00 – 8/4 08:00」 */
export function formatPeriodRange(start: number, end: number): string {
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return `${fmt(start)} – ${fmt(end)}`;
}
