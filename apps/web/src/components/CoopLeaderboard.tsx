import { useEffect, useState } from 'react';
import { resolveInputMode, type Difficulty, type GameMode, type InputMode } from '@eorzea/shared/battle';
import { DIFFICULTY_LABEL, INPUT_MODE_LABEL } from '../battle/constants';
import { fetchCoopLeaderboard, type CoopLeaderboardRow } from '../engine/accountApi';

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

function mainMetric(row: CoopLeaderboardRow, gameMode: GameMode): string {
  if (gameMode === 'endless') {
    return `${row.kills ?? 0} 只 · ${formatDuration(row.survivedMs ?? 0)}`;
  }
  return row.clearMs !== null ? formatDuration(row.clearMs) : '—';
}

/** 联机团队榜——跟单机榜同一套视觉,只是每一行显示两个名字绑在一起 */
export function CoopLeaderboard({ gameMode, difficulty, inputMode, compact, title }: CoopLeaderboardProps) {
  const track = resolveInputMode(difficulty, inputMode);
  const [rows, setRows] = useState<CoopLeaderboardRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    fetchCoopLeaderboard(gameMode, difficulty, track)
      .then((r) => { if (alive) setRows(r); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, [gameMode, difficulty, track]);

  return (
    <div className={`leaderboard${compact ? ' leaderboard--compact' : ''}`}>
      <div className="leaderboard__title">艾欧泽亚打字王 · 联机组队</div>
      <div className="leaderboard__track">
        {title ?? `${gameMode === 'endless' ? '无限模式' : '标准模式'} · ${DIFFICULTY_LABEL[difficulty]} · ${INPUT_MODE_LABEL[track]}`}
      </div>

      {rows === null && <div className="leaderboard__empty">读取中…</div>}
      {rows?.length === 0 && (
        <div className="leaderboard__empty">
          还没有队伍上榜。
          <br />
          联机时房主开局勾选"上传成绩到排行榜",双方都登录即可。
        </div>
      )}

      {rows && rows.length > 0 && (
        <ol className="leaderboard__list">
          {rows.map((row) => (
            <li key={`${row.rank}-${row.playerAName}-${row.playerBName}`} className="leaderboard__row">
              <span className={`leaderboard__rank leaderboard__rank--${row.rank <= 3 ? row.rank : 'n'}`}>
                {row.rank}
              </span>
              <span className="leaderboard__who">
                <span className="leaderboard__name">{row.playerAName} & {row.playerBName}</span>
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
    </div>
  );
}
