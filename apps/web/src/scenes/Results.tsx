import { useEffect, useRef, useState } from 'react';
import { CHARACTER_LABEL, DIFFICULTY_LABEL, INPUT_MODE_LABEL, PLAYER_MAX_HP } from '../battle/constants';
import { bestRecord, saveRecord, type GameRecord } from '../engine/records';
import { submitScore, type Session } from '../engine/accountApi';
import { RANKED_DIFFICULTIES } from '../battle/constants';
import type { SoloResult } from './SoloBattle';

export interface ResultsProps {
  result: SoloResult;
  session: Session | null;
  onGoAccount: () => void;
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

export function Results({ result, session, onGoAccount, onBackToMenu, onRetry }: ResultsProps) {
  const [uploadState, setUploadState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [showReview, setShowReview] = useState(false);

  /**
   * 能不能上榜。四个条件缺一不可:
   *   1. 登录了 —— 榜单要有名字
   *   2. 难度是困难或地狱(需求 Q22)
   *   3. 标准模式必须通关;无限模式没有「通关」概念,一律可传
   *   4. 有原始遥测可交 —— 服务端要靠它重放核算
   */
  const rankable = !!session
    && RANKED_DIFFICULTIES.includes(result.difficulty)
    && (result.gameMode === 'endless' || result.victory)
    && result.attempts.length > 0;

  const upload = async () => {
    if (!session) return;
    setUploadState('sending');
    setUploadMsg(null);
    try {
      const r = await submitScore(session, {
        seed: result.seed,
        gameMode: result.gameMode,
        difficulty: result.difficulty,
        inputMode: result.inputMode,
        character: result.character,
        mode: result.mode,
        categories: result.categories,
        pureOnly: result.pureOnly,
        attempts: result.attempts,
        elapsedMs: result.stats.elapsedMs,
        claimed: {
          score: result.score,
          kills: result.endless?.kills,
          survivedMs: result.endless?.survivedMs,
          clearMs: result.gameMode === 'standard' && result.victory ? result.stats.elapsedMs : undefined,
        },
      });
      setUploadState('done');
      setUploadMsg(
        r.status === 'inserted' ? '已上榜！'
          : r.status === 'improved' ? '刷新了你自己的纪录！'
          : '这次没超过你之前的成绩，榜上保留原来那条。',
      );
    } catch (e) {
      const msg = String(e);
      setUploadState('error');
      // 服务端重放核算把成绩拒了的话,原因要说清楚,不能只丢一句「失败」
      setUploadMsg(
        msg.includes('score_overclaim') ? '服务端核算的分数与本地对不上，这次成绩不予收录。'
          : msg.includes('word_not_in_sequence') ? '词序核对失败，这次成绩不予收录。'
          : msg.includes('not_cleared') ? '标准模式只收通关的成绩。'
          : msg.includes('unranked_difficulty') ? '只有困难和地狱难度会计入排行榜。'
          : `上传失败：${msg}`,
      );
    }
  };

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
          <span className="results__stat-label">本局时长</span>
          <span className="results__stat-value">{formatDuration(stats.elapsedMs)}</span>
        </div>
        <div className="results__stat">
          <span className="results__stat-label">剩余血量</span>
          <span className="results__stat-value">{result.playerHp} / {PLAYER_MAX_HP}</span>
        </div>
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

      {result.wordsReview.length > 0 && (
        <div className="results__review">
          <button
            className="results__review-toggle"
            onClick={() => setShowReview((v) => !v)}
            aria-expanded={showReview}
          >
            {showReview ? '收起' : '展开'} 词语复盘({result.wordsReview.length})
          </button>
          {showReview && (
            <ol className="results__review-list">
              {result.wordsReview.map((w) => (
                <li
                  key={w.id}
                  className={`results__review-item results__review-item--${w.outcome}`}
                >
                  <span className="results__review-text">{w.text}</span>
                  <span className="results__review-reading">{w.reading}</span>
                  <span className="results__review-outcome">
                    {w.outcome === 'correct' ? '✓' : '✗'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="results__upload">
        {rankable && uploadState !== 'done' && (
          <>
            <button className="results__upload-btn" disabled={uploadState === 'sending'} onClick={() => void upload()}>
              {uploadState === 'sending' ? '上传中…' : '上传成绩到排行榜'}
            </button>
            <span className="results__upload-hint">上传后服务端会重新核算一遍，你可以选择不传</span>
          </>
        )}
        {uploadState === 'done' && <div className="results__upload-ok">{uploadMsg}</div>}
        {uploadState === 'error' && <div className="menu__error">{uploadMsg}</div>}

        {!session && (
          <div className="results__upload-hint">
            还没登录，这局成绩只存在本机。
            <button className="menu__changelog-link" onClick={onGoAccount}>申请 / 登录</button>
          </div>
        )}
        {session && !rankable && (
          <div className="results__upload-hint">
            {!RANKED_DIFFICULTIES.includes(result.difficulty)
              ? '只有困难和地狱难度会计入排行榜。'
              : '标准模式要通关才能上榜。'}
          </div>
        )}
      </div>

      <div className="results__actions">
        <button onClick={onRetry}>再来一局</button>
        <button onClick={onBackToMenu}>返回主菜单</button>
      </div>
    </div>
  );
}
