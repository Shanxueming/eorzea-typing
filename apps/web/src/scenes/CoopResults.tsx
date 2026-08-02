import type { PlayerResult } from '@eorzea/shared/types';
import { verdictOf } from '@eorzea/shared/battle';

export interface CoopResultsProps {
  results: PlayerResult[];
  selfId: string;
  victory: boolean;
  onExit: () => void;
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

export function CoopResults({ results, selfId, victory, onExit }: CoopResultsProps) {
  const sorted = [...results].sort((a, b) => b.score - a.score);

  // rejected 的成绩仍然展示,但不计入排名号
  let rank = 0;

  return (
    <div className="results">
      <h1 className="results__title">{victory ? '泰坦已讨伐' : '战斗结束'}</h1>
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
