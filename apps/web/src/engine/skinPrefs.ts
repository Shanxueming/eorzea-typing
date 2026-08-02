/**
 * 皮肤选择是纯本地偏好,不进战斗协议——联机双方看到的对方外观各自本地决定,
 * 不需要也没有字段去同步"对方选了第几套皮肤"。
 */
export type SkinSlot = 'p1' | 'p2' | 'rabbit';

const KEY_PREFIX = 'eorzea-skin-';

export function getSkinIndex(slot: SkinSlot): number {
  const raw = localStorage.getItem(KEY_PREFIX + slot);
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function setSkinIndex(slot: SkinSlot, index: number): void {
  localStorage.setItem(KEY_PREFIX + slot, String(index));
}
