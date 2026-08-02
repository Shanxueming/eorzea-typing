import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AvatarState } from '@eorzea/shared/types';
import { avatarSkinPath, rabbitStylePath, useAssetAvailable } from '../engine/assets';
import { getSkinIndex } from '../engine/skinPrefs';
import { audio } from '../engine/audio';

const SMOKE_PUFFS = 4;

export interface CombatText {
  id: number;
  kind: 'damage' | 'hurt';
  amount: number;
}

export interface AvatarProps {
  state: AvatarState;
  nick: string;
  isSelf: boolean;
  /** 'p1' | 'p2',决定读哪张图与降级配色 */
  slot: 'p1' | 'p2';
  /** 头像头顶的浮动伤害数字；id 变化会创建新节点，从而可靠重播动画。 */
  combatTexts?: readonly CombatText[];
}

/**
 * ★ 连打时动画必须能重播:全部用 Web Animations API 的 el.animate() 现场创建新动画,
 *   不切 class —— 切 class 在同一个值上重复设置时浏览器不会重新触发,需要 reflow hack。
 *   调用方(战斗场景)需要在两次 attack/miss 之间把 state 弹回 'idle' 再切换,
 *   这样 useEffect 的依赖才会变化、才会真正重新执行。
 */
export function Avatar({ state, nick, isSelf, slot, combatTexts = [] }: AvatarProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rabbitRef = useRef<HTMLDivElement | null>(null);
  const smokeRef = useRef<HTMLDivElement | null>(null);
  const [showRabbit, setShowRabbit] = useState(false);
  // 皮肤选择只在 MainMenu 里改,战斗中 Avatar 是新挂载的实例,不需要监听变化
  const imgUrl = avatarSkinPath(slot, getSkinIndex(slot));
  const rabbitUrl = rabbitStylePath(getSkinIndex('rabbit'));
  const hasAvatarImg = useAssetAvailable(imgUrl);
  const hasRabbitImg = useAssetAvailable(rabbitUrl);

  // 常驻 idle 浮动,独立于 attack/miss 的一次性动画
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;
    const anim = el.animate(
      [
        { transform: 'translateY(0px)' },
        { transform: 'translateY(-3px)' },
        { transform: 'translateY(0px)' },
      ],
      { duration: 2400, iterations: Infinity, easing: 'ease-in-out' },
    );
    return () => anim.cancel();
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return undefined;

    if (state === 'attack') {
      el.animate(
        [
          { transform: 'scale(1) translateY(0)' },
          { transform: 'scale(1.35) translateY(-14px)', offset: 0.55 },
          { transform: 'scale(0.95) translateY(0)', offset: 0.85 },
          { transform: 'scale(1) translateY(0)' },
        ],
        { duration: 360, easing: 'ease-out' },
      );
    } else if (state === 'miss') {
      el.animate(
        [
          { transform: 'rotate(0deg)' },
          { transform: 'rotate(-6deg)', offset: 0.2 },
          { transform: 'rotate(6deg)', offset: 0.4 },
          { transform: 'rotate(-6deg)', offset: 0.6 },
          { transform: 'rotate(6deg)', offset: 0.8 },
          { transform: 'rotate(0deg)' },
        ],
        { duration: 360, easing: 'ease-in-out' },
      );
      setShowRabbit(true);
      audio.play('poof');
      const t = window.setTimeout(() => setShowRabbit(false), 600);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [state]);

  useEffect(() => {
    if (!showRabbit) return;
    const el = rabbitRef.current;
    if (!el) return;
    el.animate(
      [
        { transform: 'translateY(0px)', opacity: 0 },
        { transform: 'translateY(-20px)', opacity: 1, offset: 0.25 },
        { transform: 'translateY(-20px)', opacity: 1, offset: 0.75 },
        { transform: 'translateY(-40px)', opacity: 0 },
      ],
      { duration: 600, easing: 'ease-out' },
    );
  }, [showRabbit]);

  // 烟雾弹一样「蓬」地炸开:几个半透明圆点朝不同方向飘散,配上 audio.ts 里新增的 poof 音效
  useEffect(() => {
    if (!showRabbit) return;
    const container = smokeRef.current;
    if (!container) return;
    const puffs = Array.from(container.children) as HTMLElement[];
    puffs.forEach((puff, i) => {
      const angle = (Math.PI * 2 * i) / puffs.length + Math.random() * 0.6;
      const dist = 14 + Math.random() * 8;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - 6;
      puff.animate(
        [
          { transform: 'translate(0px, 0px) scale(0.3)', opacity: 0.9 },
          { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) scale(1)`, opacity: 0.6, offset: 0.4 },
          { transform: `translate(${dx}px, ${dy}px) scale(1.6)`, opacity: 0 },
        ],
        { duration: 480 + i * 30, easing: 'ease-out' },
      );
    });
  }, [showRabbit]);

  return (
    <div className={`avatar avatar--${slot}${isSelf ? ' avatar--self' : ''}`}>
      <div className="avatar__stage">
        <div className="avatar__combat-texts" aria-live="polite">
          {combatTexts.map((text, index) => (
            <span
              key={text.id}
              className={`avatar__combat-text avatar__combat-text--${text.kind}`}
              style={{ '--combat-text-index': index } as CSSProperties}
            >
              {text.kind === 'damage' ? `${text.amount}` : `-${text.amount}`}
            </span>
          ))}
        </div>
        {showRabbit && (
          <>
            <div ref={smokeRef} className="avatar__smoke">
              {Array.from({ length: SMOKE_PUFFS }, (_, i) => (
                <span key={i} className="avatar__smoke-puff" />
              ))}
            </div>
            <div ref={rabbitRef} className="avatar__rabbit">
              {hasRabbitImg ? <img src={rabbitUrl} alt="miss" /> : <span>?</span>}
            </div>
          </>
        )}
        <div ref={bodyRef} className={`avatar__body avatar__body--${slot}`}>
          {hasAvatarImg ? (
            <img src={imgUrl} alt={nick} draggable={false} />
          ) : (
            <span className="avatar__fallback">{nick.trim().slice(0, 1).toUpperCase() || '?'}</span>
          )}
        </div>
      </div>
      <div className="avatar__nick">{nick}</div>
    </div>
  );
}
