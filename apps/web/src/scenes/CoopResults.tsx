import type { PlayerResult } from '@eorzea/shared/types';
import { verdictOf, type GameMode } from '@eorzea/shared/battle';
import type { CoopLeaderboardOutcome } from '../engine/coopProtocol';

export interface CoopResultsProps {
  results: PlayerResult[];
  selfId: string;
  victory: boolean;
  gameMode: GameMode;
  /** 无限模式:打倒了几只泰坦 */
  kills: number;
  leaderboard: CoopLeaderboardOutcome | null;
  onExit: () => void;
}

const LEADERBOARD_INELIGIBLE_LABELS: Record<string, string> = {
  need_two_players: '房间里不足两人,没法组队上榜。',
  not_both_logged_in: '双方都登录才能上团队榜,这局有人没登录。',
  unranked_difficulty: '只有困难和地狱难度会计入排行榜。',
  not_cleared: '标准模式只收通关的成绩。',
  missing_result: '没能取到双方的结算数据。',
};

function leaderboardMessage(outcome: CoopLeaderboardOutcome): string {
  switch (outcome.status) {
    case 'inserted': return '团队成绩已上榜！';
    case 'improved': return '刷新了你们团队自己的纪录！';
    case 'not_better': return '这次没超过你们团队之前的成绩，榜上保留原来那条。';
    case 'ineligible': return LEADERBOARD_INELIGIBLE_LABELS[outcome.reason] ?? '这局成绩没能上传排行榜。';
    default: return '';
  }
}

const FLAG_LABELS: Record<string, string> = {
  insufficient_data: '样本太少,未做统计判定',
  low_rhythm_variance: '击键节奏过于均匀',
  superhuman_key_rate: '超人手速占比过高',
  zero_corrections: '长时间零退格',
  instant_reaction: '首键反应过快',
  superhuman_precision: '准确率与速度组合超出常人',
  excessive_blur: '页面失焦时间过长',
  quantized_timing: '击键间隔过于规律',
  word_id_mismatch: '提交词条与预期不符',
  untrusted_event: '含非受信输入事件',
  time_travel: '时间线异常',
  clock_skew: '客户端时钟偏差过大',
  keystroke_deficit: '击键次数明显少于文本长度(疑似粘贴)',
  disconnected: '对局中断线',
};

export function CoopResults({ results, selfId, victory, gameMode, kills, leaderboard, onExit }: CoopResultsProps) {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const isEndless = gameMode === 'endless';

  // rejected 的成绩仍然展示,但不计入排名号
  let rank = 0;

  return (
    <div className="results">
      <h1 className="results__title">
        {isEndless ? '无限模式结束' : victory ? '泰坦已讨伐' : '战斗结束'}
      </h1>
      {isEndless && (
        <div className="results__endless">
          <div className="results__endless-main">
            团队打倒了 <strong>{kills}</strong> 只泰坦
          </div>
        </div>
      )}
      {leaderboard && (
        <div className={leaderboard.status === 'ineligible' ? 'menu__error' : 'results__upload-ok'}>
          {leaderboardMessage(leaderboard)}
        </div>
      )}
      {sorted.map((r) => {
        const verdict = verdictOf(r.trustScore);
        const rejected = verdict === 'rejected';
        if (!rejected) rank += 1;

        return (
          <div key={r.playerId} className="results__grid" style={{ width: '100%' }}>
            <div className="results__stat" style={{ gridColumn: '1 / -1' }}>
              <span className="results__stat-label">
                {rejected ? '不计入排名' : `#${rank}`} {r.nick}
                {r.playerId === selfId ? '(你)' : ''}
                {verdict === 'unverified' && <span className="results__badge results__badge--unverified">未验证</span>}
                {verdict === 'rejected' && <span className="results__badge results__badge--rejected">不计入排名</span>}
              </span>
              <span className="results__stat-value">{r.score} 分</span>
            </div>
            <div className="results__stat">
              <span className="results__stat-label">完成词数</span>
              <span className="results__stat-value">{r.wordsCompleted}</span>
            </div>
            <div className="results__stat">
              <span className="results__stat-label">失误数</span>
              <span className="results__stat-value">{r.misses}</span>
            </div>
            <div className="results__stat">
              <span className="results__stat-label">正确率</span>
              <span className="results__stat-value">{(r.accuracy * 100).toFixed(1)}%</span>
            </div>
            <div className="results__stat">
              <span className="results__stat-label">打断成功</span>
              <span className="results__stat-value">{r.interruptsSucceeded}</span>
            </div>
            {verdict !== 'verified' && r.flags.length > 0 && (
              <div className="results__stat" style={{ gridColumn: '1 / -1' }}>
                <span className="results__stat-label">命中的检测项</span>
                <span className="results__stat-value" style={{ fontSize: 13, fontWeight: 400 }}>
                  {r.flags.map((f) => FLAG_LABELS[f] ?? f).join('、')}
                </span>
              </div>
            )}
          </div>
        );
      })}
      <div className="results__actions">
        <button onClick={onExit}>返回主菜单</button>
      </div>
    </div>
  );
}
