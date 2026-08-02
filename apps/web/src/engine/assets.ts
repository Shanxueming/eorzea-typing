/**
 * 素材探测与降级。assets/ 下的文件全部可选,运行时用 Image().onerror 探测,
 * 不使用构建期 glob —— 素材是人工后续放进去的,构建期不知道它们是否存在。
 *
 * 多皮肤约定:1 号皮肤沿用原本的文件名(p1.png / rabbit.png),
 * 2 号及以后按 `p1-2.png`、`rabbit-3.png` 这样加序号后缀,放几张就探测到几张,
 * 不要求连续也不要求提前登记 —— 探测按固定上限逐个探测,不存在的直接跳过。
 */
import { useEffect, useState } from 'react';

export const ASSET_PATHS = {
  p1: '/assets/avatar/p1.png',
  p2: '/assets/avatar/p2.png',
  rabbit: '/assets/effects/rabbit.png',
  bossTitan: '/assets/boss/titan.png',
} as const;

export const MAX_SKIN_INDEX = 6;

export function avatarSkinPath(slot: 'p1' | 'p2', index: number): string {
  return index <= 1 ? `/assets/avatar/${slot}.png` : `/assets/avatar/${slot}-${index}.png`;
}

export function rabbitStylePath(index: number): string {
  return index <= 1 ? '/assets/effects/rabbit.png' : `/assets/effects/rabbit-${index}.png`;
}

const cache = new Map<string, Promise<boolean>>();

function probeImage(url: string): Promise<boolean> {
  let hit = cache.get(url);
  if (!hit) {
    hit = new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = url;
    });
    cache.set(url, hit);
  }
  return hit;
}

/** 探测某个图片素材是否存在,缺失时返回 false,由调用方走 CSS 降级路径 */
export function useAssetAvailable(url: string): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    probeImage(url).then((v) => {
      if (alive) setOk(v);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return ok;
}

/** 探测 1..MAX_SKIN_INDEX 里实际存在的编号,放几张就出现几个选项 */
export function useAvailableSkins(pathFor: (index: number) => string): number[] {
  const [indices, setIndices] = useState<number[]>([1]);
  useEffect(() => {
    let alive = true;
    const candidates = Array.from({ length: MAX_SKIN_INDEX }, (_, i) => i + 1);
    Promise.all(candidates.map((i) => probeImage(pathFor(i)).then((ok) => (ok ? i : null)))).then((results) => {
      if (!alive) return;
      const found = results.filter((x): x is number => x !== null);
      setIndices(found.length > 0 ? found : [1]);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return indices;
}
