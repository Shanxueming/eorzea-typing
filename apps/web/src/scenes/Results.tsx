import type { SoloResult } from './SoloBattle';

export interface ResultsProps {
  result: SoloResult;
  onBackToMenu: () => void;
  onRetry: () => void;
}

const TITLE_BY_REASON: Record<SoloResult['reason'], string> = {
  boss_defeated: '泰坦已讨伐',
  player_defeated: '你倒下了',
  time_up: '时间耗尽',
};

export function Results({ result, onBackToMenu, onRetry }: ResultsProps) {
  const { stats } = result;
  return (
    <div className="results">
      <h1 className="results__title">{TITLE_BY_REASON[result.reason]}</h1>
      <div className="results__score">得分 {result.score}</div>

      <div className="results__grid">
        <div className="results__stat">
          <span className="results__stat-label">总伤害</span>
          <span className="results__stat-value">{result.damage}</span>
        </div>
        <div className="results__stat">
          <span className="results__stat-label">完成词数</span>
          <span className="results__stat-value">{stats.wordsCompleted}</span>
        </div>
        <div className="results__stat">
          <span className="results__stat-label">失误数</span>
          <span className="results__stat-value">{stats.misses}</span>
        </div>
        <div className="results__stat">
          <span className="results__stat-label">正确率</span>
          <span className="results__stat-value">{(stats.accuracy * 100).toFixed(1)}%</span>
        </div>
        <div className="results__stat">
          <span className="results__stat-label">CPM</span>
          <span className="results__stat-value">{stats.cpm}</span>
        </div>
        <div className="results__stat">
          <span className="results__stat-label">WPM</span>
          <span className="results__stat-value">{stats.wpm}</span>
        </div>
        <div className="results__stat">
          <span className="results__stat-label">打断成功</span>
          <span className="results__stat-value">{result.interruptsSucceeded}</span>
        </div>
        <div className="results__stat">
          <span className="results__stat-label">打断失败</span>
          <span className="results__stat-value">{result.interruptsFailed}</span>
        </div>
      </div>

      <div className="results__actions">
        <button onClick={onRetry}>再来一局</button>
        <button onClick={onBackToMenu}>返回主菜单</button>
      </div>
    </div>
  );
}
