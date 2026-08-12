import { useEffect, useState } from 'react';
import { fetchDailyLeaderboard, fetchDailyToday, type DailyRow } from '../engine/accountApi';
import { formatCountdown, useTicker } from '../engine/useTicker';

const POLL_INTERVAL_MS = 60_000;
const TICK_INTERVAL_MS = 30_000;
const VISIBLE_ROWS = 5;

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 每日挑战榜。和正式榜(Leaderboard.tsx)长得一样,但赛道只有一条 ——
 * 每日挑战的配置是固定的(见 DAILY_CHALLENGE_CONFIG),不需要选难度/输入模式。
 */
export function DailyLeaderboard({ compact }: { compact?: boolean }) {
  const [rows, setRows] = useState<DailyRow[] | null>(null);
  const [dateKey, setDateKey] = useState<string | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const now = useTicker(TICK_INTERVAL_MS);

  useEffect(() => {
    let alive = true;
    const pull = () => {
      void fetchDailyLeaderboard().then((r) => {
        if (!alive || !r) return;
        setRows(r.rows);
        setDateKey(r.dateKey);
      });
    };
    pull();
    // 换题时刻由服务端给,不自己按本地时区推——理由同 MainMenu 里 startDaily 的注释
    void fetchDailyToday().then((t) => { if (alive && t) setEndsAt(t.endsAt); });
    const timer = setInterval(pull, POLL_INTERVAL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const visibleRows = rows && !expanded ? rows.slice(0, VISIBLE_ROWS) : rows;

  return (
    <div className={`leaderboard${compact ? ' leaderboard--compact' : ''}`}>
      <div className="leaderboard__title">每日挑战 · 今日榜</div>
      <div className="leaderboard__track">
        {dateKey ?? '…'} · 全站同一批词 · 困难 · 组合输入
      </div>
      {endsAt !== null && (
        <div className="leaderboard__refresh">距换新题还有 {formatCountdown(endsAt - now)}</div>
      )}

      {rows === null && <div className="leaderboard__empty">读取中…</div>}
      {rows?.length === 0 && (
        <div className="leaderboard__empty">
          今天还没有人通关。
          <br />
          打完这一局在结算页点「上传成绩到今日榜」，第一个就是你。
        </div>
      )}

      {visibleRows && visibleRows.length > 0 && (
        <ol className="leaderboard__list">
          {visibleRows.map((row) => (
            <li key={`${row.rank}-${row.displayId}`} className="leaderboard__row">
              <span className={`leaderboard__rank leaderboard__rank--${row.rank <= 3 ? row.rank : 'n'}`}>
                {row.rank}
              </span>
              <span className="leaderboard__who">
                <span className="leaderboard__name">{row.displayId}</span>
                {!compact && (
                  <span className="leaderboard__meta">
                    {row.character} · {(row.accuracy * 100).toFixed(0)}% · {row.cpm} CPM
                    {row.trustScore < 70 && <span className="leaderboard__flag">待复核</span>}
                  </span>
                )}
              </span>
              <span className="leaderboard__metric">{formatDuration(row.clearMs)}</span>
            </li>
          ))}
        </ol>
      )}
      {rows && rows.length > VISIBLE_ROWS && (
        <button type="button" className="leaderboard__expand" onClick={() => setExpanded((e) => !e)}>
          {expanded ? '收起' : `展开全部 ${rows.length} 条`}
        </button>
      )}
    </div>
  );
}
