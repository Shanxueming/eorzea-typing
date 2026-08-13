import { useEffect, useRef, useState } from 'react';
import { CHARACTER_LABEL, DIFFICULTY_LABEL, INPUT_MODE_LABEL } from '../battle/constants';
import { bestRecord, saveRecord, type GameRecord } from '../engine/records';
import { recordReviewOutcomes } from '../engine/mistakes';
import {
  fetchPercentile, logSession, submitDailyScore, submitScore,
  type PercentileResult, type Session,
} from '../engine/accountApi';
import { RANKED_DIFFICULTIES } from '../battle/constants';
import { shareResultImage } from '../engine/shareImage';
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
  const [reviewFilter, setReviewFilter] = useState<'all' | 'correct' | 'missed'>('all');

  const { stats, endless } = result;
  const isEndless = result.gameMode === 'endless';

  /** 这一局是每日挑战 —— 交的是每日榜,不是正式榜 */
  const isDaily = !!result.dailyDateKey;

  /**
   * 结算页怎么称呼这一局。按玩法变体判断,**不要拿 unranked 反推** ——
   * 那个字段只回答「算不算分」,突然死亡和错题练习都不算分,用它当标签
   * 会把错题练习写成「突然死亡模式」。
   */
  const trackLabel = isDaily ? `每日挑战 ${result.dailyDateKey}`
    : result.variant === 'sudden_death' ? '突然死亡模式'
    : result.variant === 'mistake_practice' ? '错题练习'
    : isEndless ? '无限模式'
    : '标准模式';

  /**
   * 能不能上榜。五个条件缺一不可:
   *   1. 登录了 —— 榜单要有名字
   *   2. 难度是困难或地狱(需求 Q22)
   *   3. 标准模式必须通关;无限模式没有「通关」概念,一律可传
   *   4. 有原始遥测可交 —— 服务端要靠它重放核算
   *   5. 不是突然死亡/错题练习这类强制不计分的赛制——它们复用了正常引擎,
   *      难度/玩法本身会满足前四条,必须专门加一道口子拦掉
   */
  const rankable = !!session
    && RANKED_DIFFICULTIES.includes(result.difficulty)
    && (result.gameMode === 'endless' || result.victory)
    && result.attempts.length > 0
    && !result.unranked;

  /** 每日挑战有自己的一套上榜条件:通关 + 登录就行(难度是固定的,不用再判) */
  const dailyUploadable = isDaily && !!session && result.victory && result.attempts.length > 0;

  /**
   * 本地纪录该记进哪个桶。每日挑战和错题练习虽然玩法/难度/输入模式的组合
   * 和普通局一样,但打的根本不是一回事(固定题目 / 自定义词池),必须分开存,
   * 否则「★ 新纪录」和「此前最佳」会拿两种局互相比。
   */
  const recordVariantKey: GameRecord['variantKey'] = isDaily ? 'daily'
    : result.variant === 'mistake_practice' ? 'mistake_practice'
    : undefined;

  /**
   * 「超越了多少人」用的是排行榜同一套比较口径(标准比 clear_ms、无限比
   * kills+survivedMs),所以能不能算这个和能不能上榜共用同一条件——不需要
   * 登录(这是只读的公开统计,谁都能看自己这局排第几),但标准模式没通关
   * 就没有 clearMs,无从比起。
   */
  // ★ 每日挑战不查这个:它有自己的今日榜,而正式榜的 percentile 统计的是
  //   另一批人(7 天一轮的标准困难赛道),拿来给每日挑战显示只会是错的口径。
  const percentileEligible = RANKED_DIFFICULTIES.includes(result.difficulty)
    && (result.gameMode === 'endless' || result.victory)
    && !result.unranked
    && !isDaily;
  const [percentile, setPercentile] = useState<PercentileResult | null>(null);
  useEffect(() => {
    if (!percentileEligible) return;
    let alive = true;
    fetchPercentile({
      gameMode: result.gameMode,
      difficulty: result.difficulty,
      inputMode: result.inputMode,
      clearMs: result.gameMode === 'standard' ? result.stats.elapsedMs : undefined,
      kills: endless?.kills,
      survivedMs: endless?.survivedMs,
    }).then((r) => { if (alive) setPercentile(r); }).catch(() => { /* 拿不到就不显示,不影响结算页其它内容 */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [percentileEligible]);

  const [shareState, setShareState] = useState<'idle' | 'busy' | 'copied' | 'downloaded' | 'error'>('idle');
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const doShare = async () => {
    if (!session) return;
    setShareState('busy');
    setShareMsg(null);
    const outcome = await shareResultImage({
      displayId: session.displayId,
      track: `${trackLabel} · ${DIFFICULTY_LABEL[result.difficulty]} · ${INPUT_MODE_LABEL[result.inputMode]}`,
      durationText: formatDuration(stats.elapsedMs),
      cpm: stats.cpm,
      rank: percentile?.total ? percentile.rank : null,
      total: percentile?.total ?? 0,
      beatPercent: percentile?.beatPercent ?? null,
    });
    if (outcome.status === 'copied') {
      setShareState('copied');
      setShareMsg('已复制到剪贴板 ✓');
    } else if (outcome.status === 'downloaded') {
      setShareState('downloaded');
      setShareMsg('这个浏览器不支持直接复制图片，已经改成下载');
    } else {
      setShareState('error');
      setShareMsg(`生成失败：${outcome.message}`);
    }
    window.setTimeout(() => setShareState('idle'), 2400);
  };

  const upload = async () => {
    if (!session) return;
    setUploadState('sending');
    setUploadMsg(null);
    try {
      const payload = {
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
      };
      // 每日挑战走自己的榜(一天一轮),不进 7 天一轮的正式榜
      const r = isDaily ? await submitDailyScore(session, payload) : await submitScore(session, payload);
      setUploadState('done');
      setUploadMsg(
        r.status === 'inserted' ? (isDaily ? '已上今日榜！' : '已上榜！')
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
          : msg.includes('daily_seed_expired') ? '今天的题目已经换了(每天零点换题)，回主菜单重新开一局吧。'
          : msg.includes('daily_config_mismatch') ? '每日挑战的规则是固定的，这局的配置对不上，不予收录。'
          : msg.includes('not_cleared') ? (isDaily ? '每日挑战只收通关的成绩。' : '标准模式只收通关的成绩。')
          : msg.includes('unranked_difficulty') ? '只有困难和地狱难度会计入排行榜。'
          : `上传失败：${msg}`,
      );
    }
  };

  // 进结算页时把这一局落盘,并拿到「落盘之前」的历史最佳用于对比。
  // 用 ref 去重:React 18 StrictMode 会把没有清理函数的 effect 多跑一次,
  // 不去重的话同一局会被记两遍(这个坑在两个战斗场景里也踩过)。
  const savedRef = useRef(false);
  const [previousBest, setPreviousBest] = useState<GameRecord | null>(null);
  /** 这一局新进错题本的词数,给下面的复盘面板做个提示 */
  const [mistakesAdded, setMistakesAdded] = useState(0);
  useEffect(() => {
    if (savedRef.current) return;
    savedRef.current = true;
    setPreviousBest(bestRecord(result.gameMode, result.difficulty, result.inputMode, recordVariantKey));
    saveRecord({
      gameMode: result.gameMode,
      difficulty: result.difficulty,
      inputMode: result.inputMode,
      variantKey: recordVariantKey,
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
    // 错题本:打错的词记进去,打对的攒毕业进度(见 engine/mistakes.ts)。
    // 纯本地,不登录也有,所以和上传成绩无关,进结算页就记。
    setMistakesAdded(recordReviewOutcomes(result.wordsReview));
  }, [result, stats, endless]);

  /**
   * 登录了就自动存一份原始存档,不管这一局要不要上传/上不上得了榜——排行榜
   * 只留每轮最好的那条,没点上传或者没打破纪录的话原始材料就彻底没地方找了
   * (五音不全的多玛#729 那次就是这样丢的)。静默失败:这只是个兜底存档,
   * 不是玩家在等的操作,失败了不重试、不提示,不能因为这个打扰结算页体验。
   * 去重同上——StrictMode 下不加 ref 会存两遍。
   */
  const loggedRef = useRef(false);
  useEffect(() => {
    if (loggedRef.current || !session) return;
    loggedRef.current = true;
    void logSession(session, {
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
      victory: result.victory,
      reason: result.reason,
      claimed: {
        score: result.score,
        kills: result.endless?.kills,
        survivedMs: result.endless?.survivedMs,
        clearMs: result.gameMode === 'standard' && result.victory ? result.stats.elapsedMs : undefined,
      },
    }).catch(() => { /* 静默失败,不影响结算页 */ });
  }, [session, result]);

  const brokeRecord = isEndless
    ? !!endless && (!previousBest || (endless.kills > (previousBest.kills ?? 0)))
    : !previousBest || result.score > previousBest.score;

  const reviewCorrectCount = result.wordsReview.filter((w) => w.outcome === 'correct').length;
  const reviewMissedCount = result.wordsReview.length - reviewCorrectCount;
  const filteredReview = result.wordsReview.filter((w) => reviewFilter === 'all' || w.outcome === reviewFilter);

  return (
    <div className="results">
      <h1 className="results__title">
        {result.variant === 'sudden_death' ? '突然死亡结束'
          : result.variant === 'mistake_practice' ? '错题练习结束'
          : isEndless ? '无限模式结束'
          : TITLE_BY_REASON[result.reason]}
      </h1>
      <div className="results__score">得分 {result.score}</div>
      <div className="results__track">
        {trackLabel} · {DIFFICULTY_LABEL[result.difficulty]} ·{' '}
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
          <span className="results__stat-value">{result.playerHp} / {result.maxHp}</span>
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
          {mistakesAdded > 0 && (
            <div className="results__upload-hint">
              有 {mistakesAdded} 个新词进了错题本，可以在主菜单单独练。
            </div>
          )}
          {showReview && (
            <>
              <div className="results__review-filters">
                <button
                  className={`results__review-filter${reviewFilter === 'all' ? ' results__review-filter--active' : ''}`}
                  onClick={() => setReviewFilter('all')}
                >
                  全部 {result.wordsReview.length}
                </button>
                <button
                  className={`results__review-filter results__review-filter--correct${reviewFilter === 'correct' ? ' results__review-filter--active' : ''}`}
                  onClick={() => setReviewFilter('correct')}
                >
                  打对 {reviewCorrectCount}
                </button>
                <button
                  className={`results__review-filter results__review-filter--missed${reviewFilter === 'missed' ? ' results__review-filter--active' : ''}`}
                  onClick={() => setReviewFilter('missed')}
                >
                  没打对 {reviewMissedCount}
                </button>
              </div>
              {filteredReview.length === 0 ? (
                <div className="results__review-empty">这一类没有词。</div>
              ) : (
                <ol className="results__review-list">
                  {filteredReview.map((w) => (
                    <li
                      key={w.id}
                      className={`results__review-item results__review-item--${w.outcome}`}
                    >
                      <span className="results__review-outcome">
                        {w.outcome === 'correct' ? '✓' : '✗'}
                      </span>
                      <span className="results__review-text">{w.text}</span>
                      <span className="results__review-reading">{w.reading}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}

      <div className="results__upload">
        {(isDaily ? dailyUploadable : rankable) && uploadState !== 'done' && (
          <>
            <button className="results__upload-btn" disabled={uploadState === 'sending'} onClick={() => void upload()}>
              {uploadState === 'sending' ? '上传中…' : isDaily ? '上传成绩到今日榜' : '上传成绩到排行榜'}
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
        {session && isDaily && !dailyUploadable && (
          <div className="results__upload-hint">每日挑战要通关才能上今日榜。</div>
        )}
        {session && !isDaily && !rankable && (
          <div className="results__upload-hint">
            {result.variant === 'sudden_death'
              ? '突然死亡模式是比赛用的规则，不计入排行榜。'
              : result.variant === 'mistake_practice'
              ? '错题练习用的是你自己的错题本，服务端没法重建这个词池，所以不计入排行榜。'
              : !RANKED_DIFFICULTIES.includes(result.difficulty)
              ? '只有困难和地狱难度会计入排行榜。'
              : '标准模式要通关才能上榜。'}
          </div>
        )}
      </div>

      <div className="results__share">
        {percentileEligible ? (
          percentile && (
            <div className="results__share-percentile">
              {percentile.total > 0
                ? <>本局超越了这条赛道本轮 <strong>{percentile.beatPercent}%</strong> 的玩家(第 {percentile.rank} / {percentile.total} 位)</>
                : '本局是这条赛道本轮的第一位挑战者'}
            </div>
          )
        ) : (
          <div className="results__share-percentile results__share-percentile--dim">
            {isDaily ? '每日挑战看今日榜的名次，不参与这项统计'
              : result.variant === 'sudden_death' ? '突然死亡模式不参与排行榜统计'
              : result.variant === 'mistake_practice' ? '错题练习不参与排行榜统计'
              : '困难/地狱难度且通关后，才会统计「超越了多少人」'}
          </div>
        )}

        <button
          className="results__share-btn"
          disabled={!session || shareState === 'busy'}
          onClick={() => void doShare()}
        >
          {shareState === 'busy' ? '生成中…' : '分享战绩截图'}
        </button>
        {!session && <span className="results__upload-hint">登录后才能生成截图(要放账号名)</span>}
        {shareMsg && (
          <span className={shareState === 'error' ? 'menu__error' : 'results__upload-ok'}>{shareMsg}</span>
        )}
      </div>

      <div className="results__actions">
        <button onClick={onRetry}>再来一局</button>
        <button onClick={onBackToMenu}>返回主菜单</button>
      </div>
    </div>
  );
}
