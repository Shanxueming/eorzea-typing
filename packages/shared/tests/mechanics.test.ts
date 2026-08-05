/**
 * Boss 特殊机制的规则单测。
 * 机制的判定与推进全是纯函数,服务端和客户端共用同一份 —— 这里把规则钉死,
 * 免得将来加机制时不小心改了既有机制的行为。
 */
import { describe, it, expect } from 'vitest';
import {
  BARREL_LANE_SIZE,
  BARREL_STONE_INDEX,
  ENDLESS_MECHANIC_THRESHOLDS,
  MECHANICS,
  createMechanicState,
  crossedThresholds,
  currentMechanicWords,
  mechanicDurationMs,
  mechanicForHpDrop,
  pickMechanicWords,
  submitMechanicWord,
  type MechanicState,
} from '../src/mechanics';
import type { WordEntry } from '../src/types';

function w(id: string, typeText: string): WordEntry {
  return { id, text: typeText, typeText, reading: '', category: 'starter', difficulty: 1, pure: true };
}

const POOL: WordEntry[] = [
  w('a', '铁壁'), w('b', '斗狮'), w('c', '水晶塔'), w('d', '丰收'),
  w('e', '二之丸'), w('f', '朝露林'), w('g', '永润路'), w('h', '叶隐'),
];

describe('血量阈值触发', () => {
  it('严格「跨过」语义:同一个阈值不会命中两次', () => {
    expect(crossedThresholds([0.67], 1.0, 0.6)).toEqual([0.67]);
    // 已经在阈值之下了,再掉血也不该再触发
    expect(crossedThresholds([0.67], 0.6, 0.5)).toEqual([]);
  });

  it('恰好落在阈值上算跨过(prev > t >= cur)', () => {
    expect(crossedThresholds([0.5], 0.51, 0.5)).toEqual([0.5]);
    expect(crossedThresholds([0.5], 0.5, 0.49)).toEqual([]);
  });

  it('★ 67% 出三连桶,33% 出三穿一', () => {
    expect(mechanicForHpDrop(1.0, 0.66, 0)).toBe('three_barrels');
    expect(mechanicForHpDrop(0.5, 0.32, 0)).toBe('three_pierce');
  });

  it('没跨过任何阈值就不出机制', () => {
    expect(mechanicForHpDrop(1.0, 0.8, 0)).toBeNull();
    expect(mechanicForHpDrop(0.6, 0.5, 0)).toBeNull();
  });

  it('一次掉血跨过多个阈值时,取更低(更难)的那个', () => {
    expect(mechanicForHpDrop(1.0, 0.1, 0)).toBe('three_pierce');
  });

  it('无限模式的四个阈值按血量从高到低排列', () => {
    const sorted = [...ENDLESS_MECHANIC_THRESHOLDS].sort((a, b) => b - a);
    expect(ENDLESS_MECHANIC_THRESHOLDS).toEqual(sorted);
    expect(ENDLESS_MECHANIC_THRESHOLDS).toHaveLength(4);
  });
});

describe('三连桶', () => {
  const make = (roll: number): MechanicState => {
    const s = createMechanicState('three_barrels', POOL, 'normal', 0, 'seed-1', roll);
    if (!s) throw new Error('机制应该能建立');
    return s;
  };

  it('★ 只在最左或最右出生,不会一开局就贴着石头', () => {
    expect(make(0.1).barrel!.position).toBe(0);
    expect(make(0.9).barrel!.position).toBe(BARREL_LANE_SIZE - 1);
  });

  it('石头固定在正中', () => {
    expect(make(0.1).barrel!.stoneIndex).toBe(BARREL_STONE_INDEX);
    expect(BARREL_STONE_INDEX).toBe(Math.floor(BARREL_LANE_SIZE / 2));
  });

  it('左右两个方向词不是同一个,否则没法区分方向', () => {
    const b = make(0.1).barrel!;
    expect(b.leftWord.id).not.toBe(b.rightWord.id);
  });

  it('打对方向词移动一格', () => {
    const s = make(0.1); // 从最左 0 出发
    const r = submitMechanicWord(s, s.barrel!.rightWord.id);
    expect(r.kind).toBe('progress');
    expect((r as { state: MechanicState }).state.barrel!.position).toBe(1);
  });

  it('★ 打错方向词原地不动 —— 不往回走,也不直接失败', () => {
    const s = make(0.1);
    const r = submitMechanicWord(s, '不存在的词');
    expect(r.kind).toBe('rejected');
    expect((r as { state: MechanicState }).state.barrel!.position).toBe(0);
  });

  it('★ 走到石头那一格即成功(从最左出发需要两步)', () => {
    let s = make(0.1);
    const right = s.barrel!.rightWord.id;
    const step1 = submitMechanicWord(s, right);
    expect(step1.kind).toBe('progress');
    s = (step1 as { state: MechanicState }).state;
    expect(submitMechanicWord(s, right).kind).toBe('cleared');
  });

  it('走到边界不会越界', () => {
    const s = make(0.1); // 在最左端
    const r = submitMechanicWord(s, s.barrel!.leftWord.id); // 继续往左
    expect((r as { state: MechanicState }).state.barrel!.position).toBe(0);
  });

  it('同时展示左右两个词供玩家选', () => {
    expect(currentMechanicWords(make(0.1))).toHaveLength(2);
  });
});

describe('三穿一', () => {
  const make = (): MechanicState => {
    const s = createMechanicState('three_pierce', POOL, 'normal', 0, 'seed-2', 0.5);
    if (!s) throw new Error('机制应该能建立');
    return s;
  };

  it('给三个互不相同的词', () => {
    const p = make().pierce!;
    expect(p.words).toHaveLength(3);
    expect(new Set(p.words.map((x) => x.id)).size).toBe(3);
  });

  it('顺序是 0..2 的一个排列,不重不漏', () => {
    const p = make().pierce!;
    expect([...p.order].sort()).toEqual([0, 1, 2]);
  });

  it('每次只展示当前该打的那一个', () => {
    expect(currentMechanicWords(make())).toHaveLength(1);
  });

  it('★ 必须按指定顺序打', () => {
    const s = make();
    const p = s.pierce!;
    const wrong = p.words[p.order[1]]; // 第二个才该打的
    expect(submitMechanicWord(s, wrong.id).kind).toBe('rejected');
  });

  it('★ 打错只作废那一个,已打对的不回退', () => {
    let s = make();
    const order = s.pierce!.order;
    const first = s.pierce!.words[order[0]];
    const r1 = submitMechanicWord(s, first.id);
    s = (r1 as { state: MechanicState }).state;
    expect(s.pierce!.solved).toBe(1);

    const r2 = submitMechanicWord(s, '乱打的词');
    expect(r2.kind).toBe('rejected');
    expect((r2 as { state: MechanicState }).state.pierce!.solved).toBe(1); // 没回退
  });

  it('按顺序打完三个即成功', () => {
    let s = make();
    const { words, order } = s.pierce!;
    for (let i = 0; i < 3; i++) {
      const r = submitMechanicWord(s, words[order[i]].id);
      if (i < 2) {
        expect(r.kind).toBe('progress');
        s = (r as { state: MechanicState }).state;
      } else {
        expect(r.kind).toBe('cleared');
      }
    }
  });
});

describe('机制时长与选词', () => {
  it('时长随难度收紧', () => {
    expect(mechanicDurationMs('three_barrels', 'normal'))
      .toBeGreaterThan(mechanicDurationMs('three_barrels', 'hard'));
    expect(mechanicDurationMs('three_barrels', 'hard'))
      .toBeGreaterThan(mechanicDurationMs('three_barrels', 'hell'));
  });

  it('三连桶/三穿一比泰坦之怒给的时间长(要打的词更多)', () => {
    expect(mechanicDurationMs('three_pierce', 'normal'))
      .toBeGreaterThan(mechanicDurationMs('titan_wrath', 'normal'));
  });

  it('★ 机制词都是短词 —— 短时挑战不该出长词', () => {
    const words = pickMechanicWords(POOL, 3, 4, 'seed-3');
    expect(words.every((x) => x.typeText.length <= 4)).toBe(true);
  });

  it('★ 池子里没有短词时退回原池,不能让机制开不出来', () => {
    const longOnly = [w('L1', '冰属性耐性降低'), w('L2', '亚拉戈市场遗迹')];
    expect(pickMechanicWords(longOnly, 2, 4, 'seed-4')).toHaveLength(2);
  });

  it('池子极小时允许重复,总比开不出机制强', () => {
    expect(pickMechanicWords([w('only', '铁壁')], 3, 4, 'seed-5')).toHaveLength(3);
  });

  it('空池子返回空,由调用方决定跳过这次机制', () => {
    expect(pickMechanicWords([], 3, 4, 'seed-6')).toEqual([]);
    expect(createMechanicState('three_pierce', [], 'normal', 0, 's', 0.5)).toBeNull();
  });

  it('同一个 seed 必须给出完全相同的机制状态(联机两端要各自算出同一份)', () => {
    const a = createMechanicState('three_pierce', POOL, 'normal', 0, 'same', 0.5);
    const b = createMechanicState('three_pierce', POOL, 'normal', 0, 'same', 0.5);
    expect(a!.pierce!.words.map((x) => x.id)).toEqual(b!.pierce!.words.map((x) => x.id));
    expect(a!.pierce!.order).toEqual(b!.pierce!.order);
  });
});

describe('注册表自洽性', () => {
  it('每条定义的 id 与它在表里的键一致', () => {
    for (const [key, def] of Object.entries(MECHANICS)) expect(def.id).toBe(key);
  });

  it('血量阈值都落在 (0,1) 开区间内', () => {
    for (const def of Object.values(MECHANICS)) {
      if (def.trigger.kind !== 'boss_hp_threshold') continue;
      for (const t of def.trigger.thresholds) {
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
      }
    }
  });

  it('两个血量机制不共用同一个阈值,否则同一时刻会打架', () => {
    const all = Object.values(MECHANICS)
      .filter((d) => d.trigger.kind === 'boss_hp_threshold')
      .flatMap((d) => (d.trigger as { thresholds: readonly number[] }).thresholds);
    expect(new Set(all).size).toBe(all.length);
  });
});
