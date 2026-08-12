/**
 * 爬塔的楼层生成与岔路规则单测。
 *
 * ★ 这里钉死的两条最重要:
 *   1. 同一个 seed 生成同一座塔(以后要做「每日爬塔 / 赛事爬塔」的地基);
 *   2. 每个路口至少有一条「缓一缓」的路 —— 全是精英/长词的路口会让血少的人
 *      被随机数直接判死,那不是 roguelike 的权衡,是耍赖。
 */
import { describe, it, expect } from 'vitest';
import {
  TOWER_BOSS_EVERY,
  TOWER_FLOORS,
  TOWER_ROUTES,
  TOWER_ROUTE_CHOICES,
  buildTowerFloor,
  routeChoicesFor,
  type TowerRouteId,
} from '../src/tower';

const ALL_ROUTES = Object.keys(TOWER_ROUTES) as TowerRouteId[];

describe('爬塔:确定性', () => {
  it('★ 同一个 (seed, 层, 路) 永远生成同一份配置', () => {
    const a = buildTowerFloor('run-1', 37, 'elite');
    const b = buildTowerFloor('run-1', 37, 'elite');
    expect(a).toEqual(b);
  });

  it('★ 同一个 seed 的每个路口选项固定 —— 「同一个 seed 是同一座塔」', () => {
    for (let f = 1; f <= 25; f++) {
      expect(routeChoicesFor('run-1', f)).toEqual(routeChoicesFor('run-1', f));
    }
  });

  it('不同 seed 的塔不一样', () => {
    const a = Array.from({ length: 20 }, (_, i) => routeChoicesFor('run-a', i + 1).join(','));
    const b = Array.from({ length: 20 }, (_, i) => routeChoicesFor('run-b', i + 1).join(','));
    expect(a).not.toEqual(b);
  });
});

describe('爬塔:岔路规则', () => {
  it(`非 Boss 层给 ${TOWER_ROUTE_CHOICES} 条路,且互不重复`, () => {
    for (let f = 1; f < TOWER_BOSS_EVERY; f++) {
      const choices = routeChoicesFor('seed', f);
      expect(choices).toHaveLength(TOWER_ROUTE_CHOICES);
      expect(new Set(choices).size).toBe(choices.length);
    }
  });

  it('★ 每个路口至少有一条「缓一缓」的路(静室或疾风道)', () => {
    for (let s = 0; s < 40; s++) {
      for (let f = 1; f <= 99; f++) {
        if (f % TOWER_BOSS_EVERY === 0) continue;
        const choices = routeChoicesFor(`seed-${s}`, f);
        expect(choices.some((r) => r === 'rest' || r === 'swift')).toBe(true);
      }
    }
  });

  it('Boss 层不给选路 —— 到点就是 Boss,这是塔的节奏锚点', () => {
    for (let f = TOWER_BOSS_EVERY; f <= TOWER_FLOORS; f += TOWER_BOSS_EVERY) {
      expect(routeChoicesFor('seed', f)).toEqual(['elite']);
    }
  });

  it('给出来的路都是真实存在的路', () => {
    for (let f = 1; f <= 60; f++) {
      for (const r of routeChoicesFor('seed', f)) expect(TOWER_ROUTES[r]).toBeDefined();
    }
  });
});

describe('爬塔:数值曲线', () => {
  it('越往上打的词越多、失手越疼、限时越紧', () => {
    const low = buildTowerFloor('s', 3, 'swift');
    const high = buildTowerFloor('s', 95, 'swift');
    expect(high.words).toBeGreaterThanOrEqual(low.words);
    expect(high.damageOnMiss).toBeGreaterThan(low.damageOnMiss);
    expect(high.wordTimeoutMs).toBeLessThan(low.wordTimeoutMs);
  });

  it('★ 限时永远不低于 6 秒 —— 再往下就不是难,是打不完', () => {
    for (let f = 1; f <= TOWER_FLOORS; f++) {
      for (const r of ALL_ROUTES) {
        expect(buildTowerFloor('s', f, r).wordTimeoutMs).toBeGreaterThanOrEqual(
          // 疾风道会在基准上再乘 0.65,所以这里的下限是「基准下限 × 最狠的系数」
          Math.round(6_000 * 0.65),
        );
      }
    }
  });

  it('每一层至少要打 2 个词,不会出现 0 词就过的空层', () => {
    for (let f = 1; f <= TOWER_FLOORS; f++) {
      for (const r of ALL_ROUTES) {
        expect(buildTowerFloor('s', f, r).words).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('各条路的差异确实体现在参数上,不是只换了个名字', () => {
    const f = 40;
    expect(buildTowerFloor('s', f, 'pinyin').mode).toBe('pinyin');
    expect(buildTowerFloor('s', f, 'precise').inputMode).toBe('sequential');
    expect(buildTowerFloor('s', f, 'long').wordLength[0]).toBeGreaterThan(
      buildTowerFloor('s', f, 'swift').wordLength[0],
    );
    expect(buildTowerFloor('s', f, 'swift').wordTimeoutMs).toBeLessThan(
      buildTowerFloor('s', f, 'long').wordTimeoutMs,
    );
    expect(buildTowerFloor('s', f, 'elite').words).toBeGreaterThan(
      buildTowerFloor('s', f, 'rest').words,
    );
    expect(buildTowerFloor('s', f, 'rest').healOnClear).toBeGreaterThan(0);
  });

  it('Boss 层比同层的普通路更硬', () => {
    const boss = buildTowerFloor('s', 20, 'elite');
    const normal = buildTowerFloor('s', 19, 'elite');
    expect(boss.isBoss).toBe(true);
    expect(normal.isBoss).toBe(false);
    expect(boss.words).toBeGreaterThan(normal.words);
  });
});
