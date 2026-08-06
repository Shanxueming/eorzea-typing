import { useEffect, useRef, useState } from 'react';
import { CHANGELOG, markLatestSeen, type ChangelogEntry } from '../data/changelog';

export interface ChangelogModalProps {
  onClose: () => void;
}

/**
 * 一条更新的正文(标题/说明/分节),最新版和历史版共用这份渲染,
 * 免得手改一处忘了改另一处。
 */
function ChangelogEntryBody({ entry }: { entry: ChangelogEntry }) {
  return (
    <>
      {entry.lead && <p className="changelog__lead">{entry.lead}</p>}
      {entry.sections.map((section) => (
        <section key={section.title} className="changelog__section">
          <h3 className="changelog__section-title">【{section.title}】</h3>
          {section.items.map((item, i) => (
            <div key={i} className="changelog__item">
              {item.name && <div className="changelog__item-name">■ {item.name}</div>}
              <div className="changelog__item-text">{item.text}</div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

/**
 * 更新说明弹窗。
 *
 * 最新一版直接展开显示;更早的版本折进「历史更新」,按版本号一条条列出,
 * 点开哪条看哪条——不然版本越攒越多,弹窗会变成没完没了的长文章。
 *
 * 正文原样保留换行(CSS 的 white-space: pre-line)—— 更新说明是按「一行一句、
 * 断在语义处」写的,自动折行会把节奏打乱。所以这里不做任何 markdown 解析,
 * 数据里写成什么样就显示成什么样。
 */
export function ChangelogModal({ onClose }: ChangelogModalProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [openVersions, setOpenVersions] = useState<Set<string>>(new Set());

  // Esc 关闭 + 打开时焦点落到关闭按钮上,键盘用户不用 tab 一路找过去
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const confirm = () => {
    markLatestSeen();
    onClose();
  };

  const toggleVersion = (version: string) => {
    setOpenVersions((prev) => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  const [latest, ...history] = CHANGELOG;

  return (
    // 点遮罩也能关。stopPropagation 挡住冒泡,免得点内容区也被当成点遮罩
    <div className="modal" role="dialog" aria-modal="true" aria-label="更新说明" onClick={confirm}>
      <div className="modal__panel" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title">更新说明</h2>
          <button ref={closeRef} className="modal__close" type="button" onClick={confirm} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="modal__body">
          <article className="changelog__entry">
            <div className="changelog__version">
              艾欧泽亚打字修行 · 更新
              <span className="changelog__date">{latest.version}</span>
            </div>
            <ChangelogEntryBody entry={latest} />
          </article>

          {history.length > 0 && (
            <div className="changelog__history">
              <h3 className="changelog__history-title">历史更新</h3>
              {history.map((entry) => {
                const open = openVersions.has(entry.version);
                return (
                  <div key={entry.version} className="changelog__history-entry">
                    <button
                      type="button"
                      className="changelog__history-toggle"
                      onClick={() => toggleVersion(entry.version)}
                      aria-expanded={open}
                    >
                      {open ? '▾' : '▸'} {entry.version}
                      <span className="changelog__date">{entry.date}</span>
                    </button>
                    {open && (
                      <div className="changelog__history-body">
                        <ChangelogEntryBody entry={entry} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="modal__footer">
          <button className="modal__confirm" type="button" onClick={confirm}>
            我知道了
          </button>
        </div>
      </div>
    </div>
  );
}
