import { useState } from 'react';
import { Leaderboard } from '../components/Leaderboard';
import { CareerPanel } from '../components/CareerPanel';
import {
  clearSession, login, register, saveSession,
  type IssuedAccount, type Session,
} from '../engine/accountApi';

export interface AccountSceneProps {
  session: Session | null;
  onSession: (s: Session | null) => void;
  onExit: () => void;
}

/**
 * 账号页。左右两侧挂排行榜 —— 中间那栏本身很窄,两边空着浪费,
 * 顺便让还没申请账号的人先看见「上榜是什么样」。
 *
 * ★ 申请成功后返回的三样东西**只出现这一次**:
 *   ID、玩家密码、root 密码。库里存的是加盐哈希,谁也查不回明文,
 *   所以这一页必须让人能一键复制、一键存图,并且反复提醒「现在就存」。
 */
export function AccountScene({ session, onSession, onExit }: AccountSceneProps) {
  const [issued, setIssued] = useState<IssuedAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [loginId, setLoginId] = useState('');
  const [loginPw, setLoginPw] = useState('');
  const [saved, setSaved] = useState(false);

  const doRegister = async () => {
    setBusy(true);
    setError(null);
    try {
      const acc = await register();
      setIssued(acc);
      setSaved(false);
    } catch (e) {
      setError(`申请失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const doLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(loginId.trim(), loginPw.trim());
      const s = { displayId: loginId.trim(), password: loginPw.trim() };
      saveSession(s);
      onSession(s);
    } catch (e) {
      const msg = String(e);
      setError(
        msg.includes('not_found') ? '没有这个 ID，检查一下有没有抄错（含 # 和后面三位数字）'
          : msg.includes('bad_password') ? '密码不对'
          : msg.includes('banned') ? '这个账号已被封禁'
          : `登录失败：${msg}`,
      );
    } finally {
      setBusy(false);
    }
  };

  /** 复制到剪贴板。navigator.clipboard 在非 HTTPS 下可能不可用,退回旧接口 */
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* 都失败就只能手抄了 */ }
      document.body.removeChild(ta);
    }
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const allText = issued
    ? `艾欧泽亚打字修行 · 账号凭证\n\n玩家 ID：${issued.displayId}\n登录密码：${issued.password}\nroot 密码：${issued.rootPassword}\n\n`
      + `登录密码用来进游戏。\nroot 密码请单独收好，忘记登录密码时凭它找管理员核对身份，游戏里永远不需要输入它。\n`
      + `两个密码都无法找回原文，只能由管理员重置。`
    : '';

  /**
   * 存成图片。用 canvas 画而不是截屏 API —— 后者要权限、在移动端还常被拒。
   * 画完直接触发下载,文件名带 ID 方便日后翻。
   */
  const saveAsImage = () => {
    if (!issued) return;
    const scale = 2; // 二倍图,手机上放大看也清楚
    const W = 720;
    const H = 460;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);

    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#7fd8e8';
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, W - 20, H - 20);

    const font = "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif";
    ctx.fillStyle = '#7fd8e8';
    ctx.font = `bold 26px ${font}`;
    ctx.fillText('艾欧泽亚打字修行 · 账号凭证', 40, 66);

    ctx.font = `15px ${font}`;
    ctx.fillStyle = '#8a97b5';
    ctx.fillText('这三样只显示这一次，务必保存好', 40, 96);

    const lines: [string, string][] = [
      ['玩家 ID', issued.displayId],
      ['登录密码', issued.password],
      ['root 密码', issued.rootPassword],
    ];
    let y = 150;
    for (const [label, value] of lines) {
      ctx.fillStyle = '#8a97b5';
      ctx.font = `14px ${font}`;
      ctx.fillText(label, 40, y);
      ctx.fillStyle = '#e9f4f7';
      ctx.font = `bold 24px ${font}`;
      ctx.fillText(value, 40, y + 30);
      y += 78;
    }

    ctx.fillStyle = '#8a97b5';
    ctx.font = `13px ${font}`;
    ctx.fillText('登录密码用来进游戏；root 密码请单独收好，', 40, 400);
    ctx.fillText('忘记登录密码时凭它找管理员核对身份。游戏里永远不需要输入 root 密码。', 40, 422);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `艾欧泽亚打字修行-${issued.displayId.replace(/[#\s]/g, '')}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  return (
    <div className="account">
      <aside className="account__side account__side--left">
        <Leaderboard gameMode="standard" difficulty="hell" inputMode="composed" compact />
      </aside>

      <main className="account__main">
        <h1 className="account__title">玩家账号</h1>

        {session && !issued && (
          <>
            <div className="account__logged-in">
              <div className="account__logged-id">{session.displayId}</div>
              <p className="account__hint">已登录。通关后可以在结算页把成绩传上榜。</p>
              <button
                onClick={() => { clearSession(); onSession(null); }}
              >
                退出登录
              </button>
            </div>
            <div className="account__career">
              <h2 className="account__section-title">我的生涯 · 最近对局</h2>
              <CareerPanel session={session} />
            </div>
          </>
        )}

        {/* ── 刚申请完:展示三样凭证 ── */}
        {issued && (
          <div className="account__issued">
            <div className="account__warn">
              ⚠ 下面三样<strong>只显示这一次</strong>。数据库里存的是加密后的结果，
              谁也查不回原文，关掉这个页面就再也看不到了。
            </div>

            <CredentialRow label="玩家 ID" value={issued.displayId}
              note="登录时输入它，含 # 和后面三位数字" onCopy={copy} copied={copied} />
            <CredentialRow label="登录密码" value={issued.password}
              note="进游戏用这个" onCopy={copy} copied={copied} />
            <CredentialRow label="root 密码" value={issued.rootPassword}
              note="★ 单独收好。忘记登录密码时凭它找管理员核对身份 —— 游戏里永远不需要输入它"
              onCopy={copy} copied={copied} emphasis />

            <div className="account__issued-actions">
              <button onClick={() => void copy(allText, '全部')}>
                {copied === '全部' ? '已复制 ✓' : '一键复制全部'}
              </button>
              <button onClick={saveAsImage}>存成图片</button>
            </div>

            <label className="account__confirm">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              我已经保存好这三样了
            </label>
            <button
              className="account__primary"
              disabled={!saved}
              onClick={() => {
                const s = { displayId: issued.displayId, password: issued.password };
                saveSession(s);
                onSession(s);
                setIssued(null);
              }}
            >
              {saved ? '用这个账号登录' : '先勾选上面那一项'}
            </button>
          </div>
        )}

        {/* ── 未登录:申请 / 登录 ── */}
        {!session && !issued && (
          <>
            <section className="account__block">
              <h2>申请一个账号</h2>
              <p className="account__hint">
                ID 和密码都是随机发放的，不用填任何东西，也不能自己起名。
                申请完记得马上保存。
              </p>
              <button className="account__primary" disabled={busy} onClick={() => void doRegister()}>
                {busy ? '申请中…' : '随机申请'}
              </button>
            </section>

            <section className="account__block">
              <h2>已经有账号</h2>
              <input
                className="account__input"
                placeholder="玩家 ID（含 #数字）"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
              />
              <input
                className="account__input"
                placeholder="登录密码"
                value={loginPw}
                onChange={(e) => setLoginPw(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void doLogin(); }}
              />
              <button disabled={busy || !loginId.trim() || !loginPw.trim()} onClick={() => void doLogin()}>
                登录
              </button>
            </section>
          </>
        )}

        {error && <div className="menu__error">{error}</div>}
        <button className="account__back" onClick={onExit}>返回主菜单</button>
      </main>

      <aside className="account__side account__side--right">
        <Leaderboard gameMode="endless" difficulty="hard" inputMode="composed" compact />
      </aside>
    </div>
  );
}

function CredentialRow({ label, value, note, onCopy, copied, emphasis }: {
  label: string;
  value: string;
  note: string;
  onCopy: (text: string, label: string) => void;
  copied: string | null;
  emphasis?: boolean;
}) {
  return (
    <div className={`credential${emphasis ? ' credential--emphasis' : ''}`}>
      <div className="credential__label">{label}</div>
      <div className="credential__value">
        <code>{value}</code>
        <button onClick={() => onCopy(value, label)}>
          {copied === label ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <div className="credential__note">{note}</div>
    </div>
  );
}
