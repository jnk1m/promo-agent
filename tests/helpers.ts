import { DEFAULT_MENU, type BroadcastRecord, type Combo, type ScheduledBroadcast } from '../src/lib/domain';
import { DEV_WORLD, generateHistory, makeWorld, type World } from '../src/lib/world/generate';
import { initState, type AgentState } from '../src/lib/state';

export function devWorld(seed = DEV_WORLD.seed): World {
  return makeWorld({ ...DEV_WORLD, seed });
}

export function devState(seed = DEV_WORLD.seed): { world: World; state: AgentState } {
  const world = devWorld(seed);
  const history = generateHistory(world);
  return { world, state: initState(history, world.products, DEFAULT_MENU) };
}

export function sched(world: World, overrides: Partial<ScheduledBroadcast> = {}): ScheduledBroadcast {
  const p = world.products[0];
  return {
    id: 'S0001',
    t: 400,
    productId: p.id,
    category: p.category,
    daypart: '저녁',
    budget: 1e12,
    marginFloor: -1e12,
    objective: 'margin',
    ...overrides,
  };
}

// 합성 실적을 손으로 만든다(테스트용). 참 함수와 무관.
export function fakeRecord(sb: ScheduledBroadcast, combo: Combo, orders: number, world: World, id = sb.id): BroadcastRecord {
  const p = world.products.find((x) => x.id === sb.productId)!;
  return {
    id,
    t: sb.t,
    productId: sb.productId,
    category: sb.category,
    daypart: sb.daypart,
    cardLevel: combo.cardLevel,
    giftId: combo.giftId,
    listPrice: p.listPrice,
    marginRate: p.marginRate,
    orders,
    cancelRate: 0.08,
  };
}
