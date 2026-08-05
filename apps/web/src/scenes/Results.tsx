import { useEffect, useRef, useState } from 'react';
import { CHARACTER_LABEL, DIFFICULTY_LABEL, INPUT_MODE_LABEL } from '../battle/constants';
import { bestRecord, saveRecord, type GameRecord } from '../engine/records';
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

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function Results({ result, onBackToMenu, onRetry }: ResultsProps) {
  const { stats, endless } = result;
  const isEndless = result.gameMode === 'endless';

  // 进结算页时把这一局落盘,并拿到「落盘之前」的历史最佳用于对比。
  // 用 ref 去重:React 18 StrictMode 会把没有清理函数的 effect 多跑一次,
  // 不去重的话同一局会被记两遍(这个坑在两个战斗场景里也踩过)。
  const savedRef = useRef(false);
  const [previousBest, setPreviousBest] = useState<GameRecord | null>(null);
  useEffect(() => {
    if (savedRef.current) return;
    savedRef.current = true;
    setPreviousBest(bestRecord(result.gameMode, result.difficulty, result.inputMode));
    saveRecord({
      gameMode: result.gameMode,
      difficulty: result.difficulty,
      inputMode: result.inputMode,
      character: result.character,
      score: result.score,
      damage: result.damage,
      wordsCompleted: stats.wordsCompleted,
      accuracy: stats.accuracy,
      cpm: stats.cpm,
      victory: result.victory,
      trustScore: result.trustScore,
      trustFlags: result.trustFlags,
      kills: endless?.kills,
      survivedMs: endless?.survivedMs,
      maxCombo: endless?.maxCombo,
      recordedAt: Date.now(),
    });
  }, [result, stats, endless]);

  const brokeRecord = isEndless
    ? !!endless && (!previousBest || (endless.kills > (previousBest.kills ?? 0)))
    : !previousBest || result.score > previousBest.score;

  return (
    <div className="results">
      <h1 className="results__title">
        {isEndless ? '无限模式结束' : TITLE_BY_REASON[result.reason]}
      </h1>
      <div className="results__score">得分 {result.score}</div>
      <div className="results__track">
        {isEndless ? '无限模式' : '标准模式'} · {DIFFICULTY_LABEL[result.difficulty]} ·{' '}
        {INPUT_MODE_LABEL[result.inputMode]} · {CHARACTER_LABEL[result.character]}
      </div>

      {isEndless && endless && (
        <div className="results__endless">
          <div className="results__endless-main">
            打倒了 <strong>{endless.kills}</strong> 只泰坦
          </div>
          <div className="results__endless-sub">
            存活 {formatDuration(endless.survivedMs)} · 最高连击 x{endless.maxCombo}
          </div>
          {previousBest?.kills !== undefined && (
            <div className="results__endless-sub">
              此前最佳:{previousBest.kills} 只 / {formatDuration(previousBest.survivedMs ?? 0)}
            </div>
          )}
        </div>
      )}

      {brokeRecord && <div className="results__new-record">★ 新纪录</div>}

      {result.trustScore < 70 && (
        <div className="results__trust-warn">
          ⚠ 本局可信度 {result.trustScore} 分
          {result.trustFlags.length > 0 && `(${result.trustFlags.join('、')})`}
          —— 这类成绩上传排行榜时会被服务端复核,可能不予收录。
        </div>
      )}

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
