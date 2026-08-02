import { useEffect, useState } from 'react';
import { useAvailableSkins } from '../engine/assets';
import { getSkinIndex, setSkinIndex, type SkinSlot } from '../engine/skinPrefs';

export interface SkinPickerProps {
  label: string;
  slot: SkinSlot;
  pathFor: (index: number) => string;
}

/**
 * 只有探测到 2 套及以上皮肤时才显示——只有一套(或压根没有,走降级方块)时,
 * 选择器本身没有意义,不占界面空间。
 */
export function SkinPicker({ label, slot, pathFor }: SkinPickerProps) {
  const indices = useAvailableSkins(pathFor);
  const [selected, setSelected] = useState(() => getSkinIndex(slot));

  useEffect(() => {
    if (indices.length > 0 && !indices.includes(selected)) {
      const fallback = indices[0];
      setSelected(fallback);
      setSkinIndex(slot, fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indices]);

  if (indices.length <= 1) return null;

  return (
    <div className="skin-picker">
      <div className="skin-picker__label">{label}</div>
      <div className="skin-picker__options">
        {indices.map((i) => (
          <button
            key={i}
            type="button"
            className={`skin-picker__option${i === selected ? ' skin-picker__option--active' : ''}`}
            onClick={() => {
              setSelected(i);
              setSkinIndex(slot, i);
            }}
          >
            <img src={pathFor(i)} alt={`${label} ${i}`} draggable={false} />
          </button>
        ))}
      </div>
    </div>
  );
}
