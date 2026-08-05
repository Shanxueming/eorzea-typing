import type { ClipboardEvent, InputHTMLAttributes, Ref } from 'react';
import type { WordEntry, TypingMode } from '@eorzea/shared/types';
import type { InputMode } from '@eorzea/shared/battle';
import type { JudgeStatus } from '@eorzea/shared/scoring';

export interface TypingFieldProps {
  entry: WordEntry | null;
  status: JudgeStatus;
  matchedLength: number;
  mode: TypingMode;
  inputProps: InputHTMLAttributes<HTMLInputElement> & { ref: Ref<HTMLInputElement> };
  /** 是否为打断词,是则红色高亮 */
  isInterrupt: boolean;
  /** 是否在目标词下方显示拼音提示(仅汉字模式下有意义)。不传则默认显示,兼容旧调用方 */
  showReading?: boolean;
  /** 组合输入下输入框要按状态变色(蓝/红/绿),逐字输入沿用原来的朴素样式 */
  inputMode?: InputMode;
  /**
   * 多个并列目标(三连桶的左右方向词)。传了就并排展示、打哪个都算数;
   * 此时逐字高亮会关掉 —— 玩家还没决定打哪个,高亮到某一个上是误导。
   */
  alternatives?: readonly WordEntry[];
}

function blockCopy(ev: ClipboardEvent<HTMLDivElement>): void {
  ev.preventDefault();
}

/**
 * 把展示文本(可能含中点/空格)里的每个字符映射到判定目标里的下标。
 * 判定目标(typeText / 去空格 reading)剥掉了展示文本里的标点,
 * 所以要贪心地把两者对齐,标点字符本身没有对应下标,渲染时按「已跳过」处理。
 */
function buildDisplayMap(display: string, target: string): number[] {
  const map: number[] = [];
  let j = 0;
  for (let i = 0; i < display.length; i++) {
    if (j < target.length && display[i] === target[j]) {
      map.push(j);
      j++;
    } else {
      map.push(-1);
    }
  }
  return map;
}

/**
 * 组合输入的三色反馈:默认/进行中是蓝,内容不匹配是红,完全匹配是绿。
 * 逐字输入不需要这套 —— 它的 error 状态只存在于「立刻结算」之前的一瞬间,
 * 染色没有意义,保留原来的朴素外观。
 */
function inputStateClass(status: JudgeStatus, inputMode: InputMode | undefined): string {
  if (inputMode !== 'composed') return '';
  if (status === 'error') return ' typing-field__input--mismatch';
  if (status === 'complete') return ' typing-field__input--matched';
  return ' typing-field__input--typing';
}

export function TypingField({
  entry,
  status,
  matchedLength,
  mode,
  inputProps,
  isInterrupt,
  showReading = true,
  inputMode,
  alternatives,
}: TypingFieldProps) {
  if (alternatives && alternatives.length > 1) {
    return (
      <div className={`typing-field typing-field--interrupt typing-field--${status}`}>
        <div className="typing-field__alts" onCopy={blockCopy} onCut={blockCopy}>
          {alternatives.map((alt) => (
            <span key={alt.id} className="typing-field__alt">{alt.text}</span>
          ))}
        </div>
        <input
          {...inputProps}
          className={`typing-field__input${inputStateClass(status, inputMode)}`}
          placeholder="打其中一个"
        />
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="typing-field typing-field--empty">
        <div className="typing-field__word">—</div>
        <input {...inputProps} className="typing-field__input" placeholder="等待出词…" />
      </div>
    );
  }

  // 拼音模式依旧展示中文题面，玩家直接用英文键盘输入完整拼音即可自动结算。
  // 汉字和拼音不能逐字一一对应，因此拼音模式不复用汉字模式的逐字高亮。
  const display = entry.text;
  const map = mode === 'hanzi' ? buildDisplayMap(display, entry.typeText) : [];

  return (
    <div className={`typing-field${isInterrupt ? ' typing-field--interrupt' : ''} typing-field--${status}`}>
      {/* 目标词不可选中/复制,不然直接粘贴到输入框就等于抄答案了 */}
      <div className="typing-field__word" onCopy={blockCopy} onCut={blockCopy}>
        {[...display].map((ch, i) => {
          const idx = map[i] ?? -1;
          const cls = mode === 'pinyin'
            ? 'typing-field__char typing-field__char--pinyin-target'
            : idx === -1
              ? 'typing-field__char typing-field__char--punct'
              : idx < matchedLength
                ? 'typing-field__char typing-field__char--matched'
                : status === 'error' && idx === matchedLength
                  ? 'typing-field__char typing-field__char--wrong'
                  : 'typing-field__char';
          return (
            <span key={i} className={cls}>
              {ch}
            </span>
          );
        })}
      </div>
      {mode === 'hanzi' && showReading && (
        <div className="typing-field__reading" onCopy={blockCopy} onCut={blockCopy}>
          {entry.reading}
        </div>
      )}
      <input
        {...inputProps}
        className={`typing-field__input${inputStateClass(status, inputMode)}`}
        placeholder={mode === 'pinyin' ? '输入拼音，完成后自动攻击' : '输入…'}
      />
    </div>
  );
}
