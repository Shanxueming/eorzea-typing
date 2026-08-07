import { useEffect, useState } from 'react';
import { resolveInputMode, type Difficulty, type GameMode, type InputMode } from '@eorzea/shared/battle';
import { DIFFICULTY_LABEL, INPUT_MODE_LABEL } from '../battle/constants';
import { fetchCoopLeaderboard, type CoopLeaderboardResult } from '../engine/accountApi';
import { formatCountdown, formatPeriodRange, useTicker } from '../engine/useTicker';

const POLL_INTERVAL_MS = 60_000;
const TICK_INTERVAL_MS = 30_000;
const VISIBLE_ROWS = 5;

export interface CoopLeaderboardProps {
  gameMode: GameMode;
  difficulty: Difficulty;
  /** 会先过 resolveInputMode 按难度收敛,理由同 Leaderboard.tsx */
  inputMode: InputMode;
  compact?: boolean;
  title?: string;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function mainMetric(row: CoopLeaderboardResult['rows'][number], gameMode: GameMode): string {
  if (gameMode === 'endless') {
    return `${row.kills ?? 0} 只 · ${formatDuration(row.survivedMs ?? 0)}`;
  }
  return row.clearMs !== null ? formatDuration(row.clearMs) : '—';
}

/** 联机团队榜——跟单机榜同一套视觉和翻页逻辑,只是每一行显示两个名字绑在一起 */
export function CoopLeaderboard({ gameMode, difficulty, inputMode, compact, title }: CoopLeaderboardProps) {
  const track = resolveInputMode(difficulty, inputMode);
  const [period, setPeriod] = useState(0);
  const [result, setResult] = useState<CoopLeaderboardResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const now = useTicker(TICK_INTERVAL_MS);

  useEffect(() => {
    let alive = true;
    setResult(null);
    setExpanded(false);
    fetchCoopLeaderboard(gameMode, difficulty, track, period)
      .then((r) => { if (alive) setResult(r); })
      .catch(() => { if (alive) setResult({ rows: [], period, periodStart: 0, periodEnd: 0, hasEarlier: false }); });
    return () => { alive = false; };
  }, [gameMode, difficulty, track, period]);

  useEffect(() => {
    if (period !== 0) return;
    const timer = setInterval(() => {
      fetchCoopLeaderboard(gameMode, difficulty, track, 0)
        .then((r) => setResult(r))
        .catch(() => { /* 静默失败,保留上一次的数据 */ });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [gameMode, difficulty, track, period]);

  // 同 Leaderboard.tsx:地狱只可能是标准模式,不用再标一遍「标准模式」
  const defaultTitle = difficulty === 'hell'
    ? `${DIFFICULTY_LABEL[difficulty]} · ${INPUT_MODE_LABEL[track]}`
    : `${gameMode === 'endless' ? '无限模式' : '标准模式'} · ${DIFFICULTY_LABEL[difficulty]} · ${INPUT_MODE_LABEL[track]}`;

  const rows = result?.rows ?? null;
  const visibleRows = rows && !expanded ? rows.slice(0, VISIBLE_ROWS) : rows;

  return (
    <div className={`leaderboard${compact ? ' leaderboard--compact' : ''}`}>
      <div className="leaderboard__title">艾欧泽亚打字王 · 联机组队</div>
      <div className="leaderboard__track">{title ?? defaultTitle}</div>
      {result && (
        <div className="leaderboard__refresh">
          {period === 0
            ? `距下一轮刷新还有 ${formatCountdown(result.periodEnd - now)}`
            : `历史榜单 · ${formatPeriodRange(result.periodStart, result.periodEnd)}`}
        </div>
      )}
      <div className="leaderboard__period-nav">
        <button
          type="button"
          disabled={!result?.hasEarlier}
          onClick={() => setPeriod((p) => p + 1)}
        >
          ◀ 上一轮
        </button>
        {period > 0 && (
          <button type="button" onClick={() => setPeriod(0)}>
            回到本轮 ▶
          </button>
        )}
      </div>

      {rows === null && <div className="leaderboard__empty">读取中…</div>}
      {rows?.length === 0 && (
        <div className="leaderboard__empty">
          {period === 0
            ? <>
                还没有队伍上榜。
                <br />
                联机时房主开局勾选"上传成绩到排行榜",双方都登录即可。
              </>
            : '这一轮没有队伍上榜。'}
        </div>
      )}

      {visibleRows && visibleRows.length > 0 && (
        <ol className="leaderboard__list">
          {visibleRows.map((row) => (
            <li key={`${row.rank}-${row.playerAName}-${row.playerBName}`} className="leaderboard__row">
              <span className={`leaderboard__rank leaderboard__rank--${row.rank <= 3 ? row.rank : 'n'}`}>
                {row.rank}
              </span>
              <span className="leaderboard__who leaderboard__who--coop">
                <span className="leaderboard__name">{row.playerAName}</span>
                <span className="leaderboard__name leaderboard__name--partner">& {row.playerBName}</span>
                {!compact && row.trustScore < 70 && (
                  <span className="leaderboard__meta">
                    <span className="leaderboard__flag">待复核</span>
                  </span>
                )}
              </span>
              <span className="leaderboard__metric">{mainMetric(row, gameMode)}</span>
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
