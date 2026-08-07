import { useCallback, useEffect, useState } from 'react';
import { CHARACTER_LABEL, DIFFICULTY_LABEL, INPUT_MODE_LABEL } from '../battle/constants';

/**
 * 管理后台。
 *
 * ★ 令牌只存在内存里,不进 localStorage —— 刷新页面就要重新登录。
 *   后台是低频操作,多登一次的代价远小于令牌被本机其它脚本读走的风险。
 * ★ 这一页从主菜单进不去,只能手敲 #admin 打开(见 App.tsx)。
 *   不是为了防谁,只是没必要让玩家看见一个自己永远用不上的入口。
 */
export interface AdminSceneProps {
  onExit: () => void;
}

interface PlayerSummary {
  id: string;
  displayId: string;
  createdAt: number;
  lastLoginAt: number | null;
  banned: boolean;
  scoreCount: number;
}

interface DailyStat {
  day: string;
  dau: number;
  soloGames: number;
  coopGames: number;
  totalGames: number;
}

interface AdminScore {
  id: number;
  displayId: string;
  gameMode: 'standard' | 'endless';
  difficulty: 'easy' | 'normal' | 'hard' | 'hell';
  inputMode: 'sequential' | 'composed';
  character: 'p1' | 'p2';
  clearMs: number | null;
  kills: number | null;
  survivedMs: number | null;
  score: number;
  accuracy: number;
  cpm: number;
  trustScore: number;
  flags: string[];
  hidden: boolean;
  createdAt: number;
}

const fmtTime = (ms: number | null) =>
  ms === null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const fmtDate = (ts: number | null) =>
  ts === null ? '从未' : new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

export function AdminScene({ onExit }: AdminSceneProps) {
  const [token, setToken] = useState<string | null>(null);
  const [factorKind, setFactorKind] = useState<'totp' | 'password' | 'none'>('password');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<'stats' | 'players' | 'scores'>('stats');
  const [keyword, setKeyword] = useState('');
  const [players, setPlayers] = useState<PlayerSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [scores, setScores] = useState<AdminScore[]>([]);
  const [stats, setStats] = useState<DailyStat[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // 找回账号的工作区
  const [rootTarget, setRootTarget] = useState('');
  const [rootInput, setRootInput] = useState('');
  const [rootResult, setRootResult] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/factor')
      .then((r) => r.json())
      .then((j: { kind?: 'totp' | 'password' | 'none' }) => setFactorKind(j.kind ?? 'password'))
      .catch(() => { /* 后台没启用时这个接口 404,保持默认文案即可 */ });
  }, []);

  const api = useCallback(async (url: string, init?: RequestInit) => {
    const res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const json = await res.json() as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error ?? res.status));
    return json;
  }, [token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      if (tab === 'stats') {
        const j = await api('/api/admin/stats');
        setStats(j.rows as DailyStat[]);
      } else if (tab === 'players') {
        const j = await api(`/api/admin/players?keyword=${encodeURIComponent(keyword)}`);
        setPlayers(j.rows as PlayerSummary[]);
        setTotal(j.total as number);
      } else {
        const j = await api('/api/admin/scores');
        setScores(j.rows as AdminScore[]);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [api, token, tab, keyword]);

  useEffect(() => { void refresh(); }, [refresh]);

  const doLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: user.trim(), password: password.trim(), second: second.trim() }),
      });
      const j = await res.json() as { token?: string; error?: string };
      if (!res.ok) {
        setError(
          j.error === 'bad_credentials' ? '用户名或密码不对'
            : j.error === 'bad_second' ? (factorKind === 'totp' ? '动态验证码不对' : '二次口令不对')
            : j.error === 'throttled' ? '太快了，等三秒再试'
            : j.error === 'disabled' ? '服务端没有启用管理后台'
            : `登录失败：${j.error}`,
        );
        return;
      }
      setToken(j.token ?? null);
      setPassword('');
      setSecond('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const verifyRoot = async () => {
    setRootResult(null);
    setNewPassword(null);
    try {
      const j = await api('/api/admin/verify-root', {
        method: 'POST',
        body: JSON.stringify({ id: rootTarget.trim(), rootPassword: rootInput.trim() }),
      });
      setRootResult(j.matched
        ? `✓ 核对通过，确认是「${j.displayId}」本人`
        : '✗ root 密码不匹配，不要给他重置密码');
    } catch (e) {
      setRootResult(String(e).includes('not_found') ? '✗ 没有这个 ID' : `✗ ${String(e)}`);
    }
  };

  const doReset = async () => {
    try {
      const j = await api('/api/admin/reset-password', {
        method: 'POST',
        body: JSON.stringify({ id: rootTarget.trim() }),
      });
      setNewPassword(j.password as string);
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleBan = async (id: string, banned: boolean) => {
    await api('/api/admin/ban', { method: 'POST', body: JSON.stringify({ id, banned }) });
    setNotice(banned ? `已封禁 ${id}` : `已解封 ${id}`);
    void refresh();
  };

  const toggleHidden = async (scoreId: number, hidden: boolean) => {
    await api('/api/admin/score-visibility', {
      method: 'POST', body: JSON.stringify({ scoreId, hidden }),
    });
    setNotice(hidden ? '已下榜' : '已恢复');
    void refresh();
  };

  // ── 未登录 ──
  if (!token) {
    return (
      <div className="admin">
        <div className="admin__login">
          <h1 className="admin__title">管理后台</h1>
          <input className="account__input" placeholder="用户名" value={user}
            onChange={(e) => setUser(e.target.value)} />
          <input className="account__input" type="password" placeholder="密码" value={password}
            onChange={(e) => setPassword(e.target.value)} />
          <input className="account__input" type="password"
            placeholder={factorKind === 'totp' ? '动态验证码（认证器 6 位）' : '二次口令'}
            value={second}
            onChange={(e) => setSecond(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doLogin(); }} />
          <button className="account__primary" disabled={busy || !user || !password || !second}
            onClick={() => void doLogin()}>
            {busy ? '验证中…' : '登录'}
          </button>
          {error && <div className="menu__error">{error}</div>}
          <button onClick={onExit}>返回游戏</button>
        </div>
      </div>
    );
  }

  // ── 已登录 ──
  return (
    <div className="admin">
      <div className="admin__bar">
        <h1 className="admin__title">管理后台</h1>
        <div className="admin__tabs">
          <button className={tab === 'stats' ? 'admin__tab--on' : ''} onClick={() => setTab('stats')}>
            数据监控
          </button>
          <button className={tab === 'players' ? 'admin__tab--on' : ''} onClick={() => setTab('players')}>
            账号（{total}）
          </button>
          <button className={tab === 'scores' ? 'admin__tab--on' : ''} onClick={() => setTab('scores')}>
            成绩
          </button>
        </div>
        <button onClick={() => { setToken(null); onExit(); }}>退出</button>
      </div>

      {notice && <div className="admin__notice">{notice}</div>}
      {error && <div className="menu__error">{error}</div>}

      {tab === 'stats' && (
        <section className="admin__panel">
          <p className="account__hint">
            设备数是按浏览器里存的匿名随机串去重的,不是精确的实名人数;联机一局
            两个人各报一次开局,已经按房间码去重成"一局"。
          </p>
          <div className="admin__row">
            <button onClick={() => void refresh()}>刷新</button>
          </div>
          <table className="admin__table">
            <thead>
              <tr><th>日期</th><th>玩过的设备数</th><th>单机局数</th><th>联机局数</th><th>合计局数</th></tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.day}>
                  <td>{s.day}</td>
                  <td>{s.dau}</td>
                  <td>{s.soloGames}</td>
                  <td>{s.coopGames}</td>
                  <td>{s.totalGames}</td>
                </tr>
              ))}
              {stats.length === 0 && <tr><td colSpan={5}>还没有数据</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'players' && (
        <>
          <section className="admin__panel">
            <h2>玩家忘了密码</h2>
            <p className="account__hint">
              让他把 root 密码发给你，在这里核对。库里存的是加密结果，
              <strong>原密码谁也查不出来</strong>，核对通过后给他重置一个新的。
            </p>
            <div className="admin__row">
              <input className="account__input" placeholder="玩家 ID（含 #数字）"
                value={rootTarget} onChange={(e) => setRootTarget(e.target.value)} />
              <input className="account__input" placeholder="他发来的 root 密码"
                value={rootInput} onChange={(e) => setRootInput(e.target.value)} />
              <button disabled={!rootTarget.trim() || !rootInput.trim()} onClick={() => void verifyRoot()}>
                核对
              </button>
            </div>
            {rootResult && (
              <div className={rootResult.startsWith('✓') ? 'admin__ok' : 'menu__error'}>{rootResult}</div>
            )}
            {rootResult?.startsWith('✓') && !newPassword && (
              <button className="account__primary" onClick={() => void doReset()}>
                重置这个账号的登录密码
              </button>
            )}
            {newPassword && (
              <div className="admin__issued">
                新的登录密码（只显示这一次，发给他）：
                <code>{newPassword}</code>
                <button onClick={() => void navigator.clipboard?.writeText(newPassword)}>复制</button>
              </div>
            )}
          </section>

          <section className="admin__panel">
            <div className="admin__row">
              <input className="account__input" placeholder="搜索 ID（留空看全部）"
                value={keyword} onChange={(e) => setKeyword(e.target.value)} />
              <button onClick={() => void refresh()}>刷新</button>
            </div>
            <table className="admin__table">
              <thead>
                <tr><th>玩家 ID</th><th>注册</th><th>最后登录</th><th>成绩</th><th>操作</th></tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id} className={p.banned ? 'admin__banned' : undefined}>
                    <td>{p.displayId}{p.banned && <span className="admin__tag">已封禁</span>}</td>
                    <td>{fmtDate(p.createdAt)}</td>
                    <td>{fmtDate(p.lastLoginAt)}</td>
                    <td>{p.scoreCount}</td>
                    <td>
                      <button onClick={() => void toggleBan(p.id, !p.banned)}>
                        {p.banned ? '解封' : '封禁'}
                      </button>
                    </td>
                  </tr>
                ))}
                {players.length === 0 && <tr><td colSpan={5}>没有账号</td></tr>}
              </tbody>
            </table>
          </section>
        </>
      )}

      {tab === 'scores' && (
        <section className="admin__panel">
          <p className="account__hint">
            可信度是服务端重放核算出来的。下榜只是隐藏，记录还在，随时能恢复。
          </p>
          <table className="admin__table">
            <thead>
              <tr>
                <th>玩家</th><th>赛道</th><th>成绩</th><th>分数</th>
                <th>可信度</th><th>时间</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {scores.map((s) => (
                <tr key={s.id} className={s.hidden ? 'admin__banned' : undefined}>
                  <td>{s.displayId}</td>
                  <td>
                    {s.gameMode === 'endless' ? '无限' : '标准'} ·{' '}
                    {DIFFICULTY_LABEL[s.difficulty]} · {INPUT_MODE_LABEL[s.inputMode]} ·{' '}
                    {CHARACTER_LABEL[s.character]}
                  </td>
                  <td>
                    {s.gameMode === 'endless'
                      ? `${s.kills ?? 0} 只 / ${fmtTime(s.survivedMs)}`
                      : fmtTime(s.clearMs)}
                  </td>
                  <td>{s.score}</td>
                  <td className={s.trustScore < 70 ? 'admin__low-trust' : undefined}>
                    {s.trustScore}
                    {s.flags.length > 0 && <div className="admin__flags">{s.flags.join('、')}</div>}
                  </td>
                  <td>{fmtDate(s.createdAt)}</td>
                  <td>
                    <button onClick={() => void toggleHidden(s.id, !s.hidden)}>
                      {s.hidden ? '恢复' : '下榜'}
                    </button>
                  </td>
                </tr>
              ))}
              {scores.length === 0 && <tr><td colSpan={7}>还没有成绩</td></tr>}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
