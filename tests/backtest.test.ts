import { describe, expect, it } from 'vitest';
import { initModel, posterior, predictLog, updateMany } from '../src/lib/estimate/model';
import { generateHistory, makeWorld, DEV_WORLD } from '../src/lib/world/generate';
import { MISSPEC_ALL_OFF } from '../src/lib/world/truth';

// T6 구간 정직성: 앞 70% 방송으로 추정, 뒤 30% 에서 80% 구간이 실제 주문 수를 포함하는 비율.
function coverage(seed: number, misspecOn: boolean): number {
  const world = makeWorld({ ...DEV_WORLD, seed, misspec: misspecOn ? DEV_WORLD.misspec : MISSPEC_ALL_OFF });
  const history = generateHistory(world);
  const cut = Math.floor(history.length * 0.7);
  const model = updateMany(initModel(), history.slice(0, cut));
  const post = posterior(model);
  let hit = 0;
  const test = history.slice(cut);
  for (const r of test) {
    const { mu, v } = predictLog(post, model, { category: r.category, daypart: r.daypart, combo: { cardLevel: r.cardLevel, giftId: r.giftId } });
    const sd = Math.sqrt(v);
    const lo = Math.exp(mu - 1.2816 * sd) - 1;
    const hi = Math.exp(mu + 1.2816 * sd) - 1;
    if (r.orders >= lo && r.orders <= hi) hit += 1;
  }
  return hit / test.length;
}

describe('T6 구간 정직성', () => {
  it('어긋남 끈 세계에서 80% 구간 포함 비율이 70% 이상', () => {
    const c = coverage(777, false);
    expect(c).toBeGreaterThanOrEqual(0.7);
  });
  it('어긋남 켠 세계는 값만 기록한다(기준 없음)', () => {
    const c = coverage(777, true);
    console.log(`T6 misspec on coverage ${(c * 100).toFixed(1)}%`);
    expect(c).toBeGreaterThanOrEqual(0);
  });
});
