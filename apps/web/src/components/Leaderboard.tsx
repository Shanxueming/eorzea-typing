import { useEffect, useState } from 'react';
import { resolveInputMode, type Difficulty, type GameMode, type InputMode } from '@eorzea/shared/battle';
import { CHARACTER_LABEL, DIFFICULTY_LABEL, INPUT_MODE_LABEL } from '../battle/constants';
import { fetchLeaderboard, type LeaderboardResult } from '../engine/accountApi';
import { formatCountdown, formatPeriodRange, useTicker } from '../engine/useTicker';

/** 只有当前这一轮(period===0)才需要轮询捕捉新提交的成绩;历史轮次已经定格,拉一次就够 */
const POLL_INTERVAL_MS = 60_000;
/** 倒计时显示的刷新粒度,不用跟到秒 */
const TICK_INTERVAL_MS = 30_000;

export interface LeaderboardProps {
  gameMode: GameMode;
  difficulty: Difficulty;
  /**
   * 想看哪种输入模式的榜。**会先过 resolveInputMode 按难度收敛** ——
   * 地狱强制逐字,所以「地狱 + 组合输入」这条赛道根本不会有成绩。
   * 曾经这里直接用传进来的值,首页的地狱榜写死 composed,结果是玩家通关地狱、
   * 传了成绩、回首页却看不到自己,而标题还写着「地狱 · 组合输入」。
   */
  inputMode: InputMode;
  /** 紧凑版:发放页两侧那种窄栏用,只显示名次和关键指标 */
  compact?: boolean;
  title?: string;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** 榜单主指标:标准模式比讨伐耗时(越快越好),无限模式比击杀数 */
function mainMetric(row: LeaderboardResult['rows'][number], gameMode: GameMode): string {
  if (gameMode === 'endless') {
    return `${row.kills ?? 0} 只 · ${formatDuration(row.survivedMs ?? 0)}`;
  }
  return row.clearMs !== null ? formatDuration(row.clearMs) : '—';
}

export function Leaderboard({ gameMode, difficulty, inputMode, compact, title }: LeaderboardProps) {
  // ★ 收敛后的才是真实赛道:地狱只有逐字,拿 composed 去查必然是空的
  const track = resolveInputMode(difficulty, inputMode);
  const [period, setPeriod] = useState(0);
  const [result, setResult] = useState<LeaderboardResult | null>(null);
  const now = useTicker(TICK_INTERVAL_MS);

  // 赛道变了(切难度/模式)或者翻页了才需要清空重新显示"读取中"
  useEffect(() => {
    let alive = true;
    setResult(null);
    fetchLeaderboard(gameMode, difficulty, track, period)
      .then((r) => { if (alive) setResult(r); })
      .catch(() => { if (alive) setResult({ rows: [], period, periodStart: 0, periodEnd: 0, hasEarlier: false }); });
    return () => { alive = false; };
  }, [gameMode, difficulty, track, period]);

  // 当前这一轮才需要轮询——历史轮次数据已经定格,不会再变
  useEffect(() => {
    if (period !== 0) return;
    const timer = setInterval(() => {
      fetchLeaderboard(gameMode, difficulty, track, 0)
        .then((r) => setResult(r))
        .catch(() => { /* 静默失败,保留上一次的数据 */ });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [gameMode, difficulty, track, period]);

  // 地狱难度只可能出现在标准模式里(无限模式恒为困难),所以不用再重复标一遍
  // 「标准模式」;困难难度两边都有,必须标出来区分。
  const defaultTitle = difficulty === 'hell'
    ? `${DIFFICULTY_LABEL[difficulty]} · ${INPUT_MODE_LABEL[track]}`
    : `${gameMode === 'endless' ? '无限模式' : '标准模式'} · ${DIFFICULTY_LABEL[difficulty]} · ${INPUT_MODE_LABEL[track]}`;

  const rows = result?.rows ?? null;

  return (
    <div className={`leaderboard${compact ? ' leaderboard--compact' : ''}`}>
      <div className="leaderboard__title">艾欧泽亚打字王</div>
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
            ? <>还没有人上榜。<br />通关后在结算页选择上传成绩，第一个就是你。</>
            : '这一轮没有人上榜。'}
        </div>
      )}

      {rows && rows.length > 0 && (
        <ol className="leaderboard__list">
          {rows.map((row) => (
            <li key={`${row.rank}-${row.displayId}`} className="leaderboard__row">
              <span className={`leaderboard__rank leaderboard__rank--${row.rank <= 3 ? row.rank : 'n'}`}>
                {row.rank}
              </span>
              <span className="leaderboard__who">
                <span className="leaderboard__name">{row.displayId}</span>
                {!compact && (
                  <span className="leaderboard__meta">
                    {CHARACTER_LABEL[row.character]} · {(row.accuracy * 100).toFixed(0)}% · {row.cpm} CPM
                    {/* 可信度偏低的成绩挂个标,不删但让人看得见 */}
                    {row.trustScore < 70 && <span className="leaderboard__flag"> · 待复核</span>}
                  </span>
                )}
              </span>
              <span className="leaderboard__metric">{mainMetric(row, gameMode)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
