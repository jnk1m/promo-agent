import { describe, expect, it } from 'vitest';
import { allCombos, type Combo } from '../src/lib/domain';
import { posterior, predictLog, updateMany, updateOne } from '../src/lib/estimate/model';
import { generateHistory } from '../src/lib/world/generate';
import { proposeFor } from '../src/lib/state';
import { devState, devWorld, fakeRecord, sched } from './helpers';
import { propose } from '../src/lib/decide/propose';
import type { Constraint } from '../src/lib/ledger/constraints';

describe('단계 0: 합성 세계', () => {
  it('시드로 방송 300건 이상을 만들고 같은 시드면 같은 결과', () => {
    const w = devWorld();
    const h1 = generateHistory(w);
    const h2 = generateHistory(w);
    expect(h1.length).toBeGreaterThanOrEqual(300);
    expect(h1).toEqual(h2);
    expect(h1.some((r) => r.orders > 0)).toBe(true);
  });
});

describe('T1 방향성', () => {
  it('좋은 실적이면 그 조합의 사후 평균이 오르고 나쁘면 내린다', () => {
    const { world, state } = devState();
    const sb = sched(world);
    const combo: Combo = { cardLevel: 7, giftId: 'B' };
    const x = { category: sb.category, daypart: sb.daypart, combo };
    const mu0 = predictLog(posterior(state.model), state.model, x).mu;
    const good = updateOne(state.model, fakeRecord(sb, combo, Math.round(Math.exp(mu0) * 3), world));
    const bad = updateOne(state.model, fakeRecord(sb, combo, Math.max(1, Math.round(Math.exp(mu0) / 3)), world));
    expect(predictLog(posterior(good), good, x).mu).toBeGreaterThan(mu0);
    expect(predictLog(posterior(bad), bad, x).mu).toBeLessThan(mu0);
  });
});

describe('T2 결정이 바뀜', () => {
  it('사전 1위가 참으로 열세인 실적 k건 뒤 1위가 바뀐다 (k <= 8)', () => {
    const { world, state } = devState();
    const sb = sched(world);
    const first = proposeFor(state, sb).chosen!;
    let model = state.model;
    let k = 0;
    let changed = false;
    for (; k < 8; k++) {
      const weak = Math.max(1, Math.round(first.orders.p50 * 0.3));
      model = updateOne(model, fakeRecord({ ...sb, t: sb.t + k }, first.combo, weak, world, `W${k}`));
      const p = propose(model, sb, world.products[0], state.menu, []);
      if (p.chosen && (p.chosen.combo.cardLevel !== first.combo.cardLevel || p.chosen.combo.giftId !== first.combo.giftId)) {
        changed = true;
        break;
      }
    }
    expect(changed).toBe(true);
  });
});

describe('T3 무관한 칸 불변', () => {
  it('다른 상품군의 기본 조합(카드 0, 사은품 없음) 실적은 이 칸의 결정안을 바꾸지 않는다', () => {
    const { world, state } = devState();
    const sb = sched(world);
    const before = proposeFor(state, sb);
    const other = world.products.find((p) => p.category !== sb.category)!;
    const osb = sched(world, { id: 'O1', productId: other.id, category: other.category, daypart: '아침' });
    let model = state.model;
    for (let i = 0; i < 5; i++) model = updateOne(model, fakeRecord(osb, { cardLevel: 0, giftId: 'none' }, 500 + i, world, `O${i}`));
    const after = propose(model, sb, world.products[0], state.menu, []);
    expect(after.chosen!.key).toBe(before.chosen!.key);
    // 카드와 사은품 효과는 상품군이 공유하므로 완전 불변이 아니다. 예측 중앙값 변화 1% 이내를 기준으로 한다.
    const rel = Math.abs(after.chosen!.orders.p50 - before.chosen!.orders.p50) / before.chosen!.orders.p50;
    expect(rel).toBeLessThan(0.01);
  });
});

describe('T4 영 증거', () => {
  it('실적 0건 갱신은 상태를 바꾸지 않는다', () => {
    const { state } = devState();
    const after = updateMany(state.model, []);
    expect(after).toEqual(state.model);
  });
});

describe('T5 순서 불변', () => {
  it('같은 실적 집합을 다른 순서로 넣어도 같은 사후', () => {
    const { world, state } = devState();
    const sb = sched(world);
    const recs = allCombos().slice(0, 6).map((c, i) => fakeRecord(sb, c, 100 + i * 17, world, `R${i}`));
    const a = updateMany(state.model, recs);
    const b = updateMany(state.model, recs.slice().reverse());
    const pa = posterior(a).mean;
    const pb = posterior(b).mean;
    for (let i = 0; i < pa.length; i++) expect(Math.abs(pa[i] - pb[i])).toBeLessThan(1e-9);
  });
});

describe('T8 하드 제약', () => {
  it('금지된 사은품은 결정안과 대안에 절대 나오지 않는다', () => {
    const { world, state } = devState();
    const sb = sched(world);
    const ban: Constraint = {
      id: 'C001',
      kind: 'ban_gift',
      scope: { category: sb.category },
      target: { giftId: 'B' },
      duration: { type: 'always' },
      quote: 'B 금지',
      sourceText: 'B 금지',
      confidence: 'high',
      status: 'active',
      createdAtT: 0,
      createdForBroadcastId: 'X',
    };
    for (const seed of [1, 2, 3]) {
      const p = propose(state.model, sb, world.products[0], state.menu, [ban], seed);
      expect(p.chosen!.combo.giftId).not.toBe('B');
      for (const a of p.alternatives) expect(a.eval.combo.giftId).not.toBe('B');
      for (const e of p.search.evals) if (e.combo.giftId === 'B') expect(e.feasible).toBe(false);
    }
  });
  it('모든 조합이 막히면 마지막 제약을 풀고 알린다', () => {
    const { world, state } = devState();
    const sb = sched(world);
    const mk = (id: string, giftId: 'A' | 'B' | 'C'): Constraint => ({ id, kind: 'ban_gift', scope: {}, target: { giftId }, duration: { type: 'always' }, quote: 'x', sourceText: 'x', confidence: 'high', status: 'active', createdAtT: 0, createdForBroadcastId: 'X' });
    const req: Constraint = { ...mk('C004', 'A'), kind: 'require_gift', target: { giftId: 'B' } };
    const p = propose(state.model, sb, world.products[0], state.menu, [mk('C001', 'A'), mk('C002', 'B'), mk('C003', 'C'), req], 1);
    expect(p.releasedConstraintId).toBe('C004');
    expect(p.chosen).not.toBeNull();
  });
});
