import { useEffect, useRef, type ReactNode } from 'react';
import { CHANGELOG, markLatestSeen } from '../data/changelog';

export interface ChangelogModalProps {
  onClose: () => void;
}

/**
 * 把 `**加粗**` 渲染成 <strong>。
 *
 * 只支持这一种标记 —— 更新说明里唯一需要的强调就是「哪几个字是重点」,
 * 为它引一个 markdown 库不值得(依赖白名单里也没有)。
 */
function renderEmphasis(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>,
  );
}

export function ChangelogModal({ onClose }: ChangelogModalProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

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
          {CHANGELOG.map((entry) => (
            <article key={entry.version} className="changelog__entry">
              <div className="changelog__version">
                {entry.version}
                <span className="changelog__date">{entry.date}</span>
              </div>
              <p className="changelog__summary">{entry.summary}</p>
              {entry.sections.map((section) => (
                <section key={section.title} className="changelog__section">
                  <h3 className="changelog__section-title">{section.title}</h3>
                  <ul className="changelog__list">
                    {section.items.map((item, i) => (
                      <li key={i}>{renderEmphasis(item)}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </article>
          ))}
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
