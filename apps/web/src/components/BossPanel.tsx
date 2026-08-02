import { useEffect, useRef } from 'react';
import type { WordEntry } from '@eorzea/shared/types';
import { HpBar } from './HpBar';
import { ASSET_PATHS, useAssetAvailable } from '../engine/assets';

export interface BossPanelProps {
  name: string;
  hp: number;
  maxHp: number;
  cast: { skillName: string; word: WordEntry; startedAt: number; castMs: number } | null;
  /** 读条被打断时播碎裂动画 */
  shattered: boolean;
}

/**
 * 碎裂动画是 tokens.css 里的 eorzea-shatter CSS 动画,靠 shattered 这个布尔量
 * 一次性触发——调用方(战斗场景)负责在 true 之后很快弹回 false,
 * 这样下次打断成功时 class 才会是从无到有地重新添加,动画才会重播。
 * 读条进度条则用 WAAPI,因为它需要跟着 castMs 这个动态时长走,天生不适合
 * 写成固定时长的 CSS 动画。
 */
export function BossPanel({ name, hp, maxHp, cast, shattered }: BossPanelProps) {
  const castBarRef = useRef<HTMLDivElement | null>(null);
  const hasSilhouette = useAssetAvailable(ASSET_PATHS.bossTitan);

  // 读条进度条:直接用真实时长驱动 WAAPI 动画,不依赖战斗时钟同步
  useEffect(() => {
    const el = castBarRef.current;
    if (!el || !cast) return undefined;
    const anim = el.animate(
      [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
      { duration: Math.max(1, cast.castMs), easing: 'linear', fill: 'forwards' },
    );
    return () => anim.cancel();
  }, [cast?.word.id, cast?.startedAt, cast?.castMs]);

  return (
    <div className={`boss-panel${shattered ? ' boss-panel--shatter' : ''}`}>
      <div className="boss-panel__art" aria-hidden="true">
        {hasSilhouette ? (
          <img className="boss-panel__titan" src={ASSET_PATHS.bossTitan} alt="" />
        ) : (
          <span className="boss-panel__titan-fallback">泰坦</span>
        )}
      </div>
      <div className="boss-panel__header">
        <span className="boss-panel__name">{name}</span>
      </div>
      <HpBar value={hp} max={maxHp} variant="boss" />
      {cast && (
        <div className="boss-panel__cast">
          <div className="boss-panel__cast-label">
            {cast.skillName}——「{cast.word.text}」
          </div>
          <div className="boss-panel__cast-track">
            <div ref={castBarRef} className="boss-panel__cast-fill" />
          </div>
        </div>
      )}
    </div>
  );
}
