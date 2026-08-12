import { useEffect, useState } from 'react';
import { fetchMySessions, type PlaySessionSummary, type Session } from '../engine/accountApi';
import { DIFFICULTY_LABEL } from '../battle/constants';

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 生涯:最近的对局记录。
 *
 * ★ 数据来自服务端的 play_sessions —— 那张表**不管有没有上传成绩**都会存,
 *   所以这里能看到的比排行榜多得多(榜上每条赛道只留你最好的那一条)。
 *   代价是只留 7 天,过期自动清理,所以这是「最近在练什么」而不是「历史全记录」。
 */
export function CareerPanel({ session }: { session: Session }) {
  const [sessions, setSessions] = useState<PlaySessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMySessions(session)
      .then((s) => { if (alive) setSessions(s); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [session.displayId]);

  if (error) return <div className="menu__error">生涯记录读取失败：{error}</div>;
  if (sessions === null) return <div className="leaderboard__empty">读取中…</div>;
  if (sessions.length === 0) {
    return (
      <div className="leaderboard__empty">
        最近 7 天还没有对局记录。
        <br />
        登录状态下打完一局就会自动存一份，不用手动上传。
      </div>
    );
  }

  const cleared = sessions.filter((s) => s.victory).length;
  /**
   * 只报「累计打了多少词」这种加起来就对的数,**不报速度类的平均值** ——
   * 开局一秒就退出的局会让「每分钟多少词」算出几百这种离谱数字
   * (分母趋近于零),而这类局在真实使用里很常见。速度看结算页那一局的
   * CPM 就够了,生涯页给的是「最近在练什么、练了多少」。
   */
  const totalWords = sessions.reduce((sum, s) => sum + s.attemptCount, 0);

  return (
    <div className="career">
      <div className="career__summary">
        最近 7 天打了 <strong>{sessions.length}</strong> 局，通关 <strong>{cleared}</strong> 局
        {totalWords > 0 && <> · 累计 <strong>{totalWords}</strong> 个词</>}
      </div>
      <ol className="career__list">
        {sessions.map((s) => (
          <li key={s.id} className={`career__row${s.victory ? ' career__row--win' : ''}`}>
            <span className="career__when">{formatWhen(s.createdAt)}</span>
            <span className="career__track">
              {s.gameMode === 'endless' ? '无限' : '标准'} · {DIFFICULTY_LABEL[s.difficulty]}
              {s.mode === 'pinyin' ? ' · 拼音' : ''}
            </span>
            <span className="career__outcome">
              {s.gameMode === 'endless'
                ? `${s.claimedKills ?? 0} 只`
                : s.victory ? `通关 ${formatDuration(s.claimedClearMs ?? s.elapsedMs)}` : '未通关'}
            </span>
            <span className="career__words">{s.attemptCount} 词</span>
          </li>
        ))}
      </ol>
      <div className="career__note">服务端只保留 7 天，过期自动清理。</div>
    </div>
  );
}
