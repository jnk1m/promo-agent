// 합성 세계: 과거 방송 실적과 「한 회 방송 실행」을 만든다. 참 함수는 truth.ts.
import { CARD_LEVELS, CATEGORIES, DAYPARTS, GIFT_IDS, allCombos, type BroadcastRecord, type Combo, type Product, type ScheduledBroadcast } from '../domain';
import { makeRng } from '../rng';
import { buildTruth, drawOrders, expectedOrders, type Truth, type WorldConfig } from './truth';

export type World = { cfg: WorldConfig; truth: Truth; products: Product[] };

export function makeWorld(cfg: WorldConfig): World {
  const truth = buildTruth(cfg);
  const rng = makeRng(cfg.seed ^ 0x51ed27);
  const products: Product[] = [];
  const names: Record<string, string[]> = {
    건강식품: ['홍삼 세트', '유산균 3개월', '오메가3 6개월'],
    뷰티: ['수분 크림 세트', '앰플 4종', '클렌저 트리오'],
    패션: ['니트 3종', '경량 패딩', '슬랙스 2종'],
    생활가전: ['무선 청소기', '에어프라이어', '공기청정기'],
    식품: ['한우 불고기 2kg', '곱창 세트', '김치 10kg'],
  };
  for (const c of CATEGORIES) {
    const priceBase = { 건강식품: 59000, 뷰티: 49000, 패션: 69000, 생활가전: 189000, 식품: 45000 }[c];
    names[c].forEach((n, i) => {
      products.push({
        id: `${c}-${i + 1}`,
        name: n,
        category: c,
        listPrice: Math.round((priceBase * (0.8 + rng.next() * 0.5)) / 1000) * 1000,
        marginRate: 0.25 + rng.next() * 0.2,
      });
    });
  }
  return { cfg, truth, products };
}

// 과거 조건 선택 정책(선택 편향). 잘 팔릴 방송에 큰 혜택을 붙이거나(boost-strong), 약한 방송을 살리려 붙이거나(rescue-weak).
function choosePastCombo(world: World, strength: number, rng: ReturnType<typeof makeRng>): Combo {
  const combos = allCombos();
  if (!world.cfg.misspec.selectionBias || world.cfg.policy === 'random') return rng.pick(combos);
  const big = rng.next() < (world.cfg.policy === 'boost-strong' ? strength : 1 - strength);
  if (big) return { cardLevel: rng.pick([7, 10] as const), giftId: rng.pick(['B', 'C'] as const) };
  return { cardLevel: rng.pick([0, 5] as const), giftId: rng.pick(['none', 'A'] as const) };
}

export function generateHistory(world: World): BroadcastRecord[] {
  const rng = makeRng(world.cfg.seed ^ 0xabcdef);
  const out: BroadcastRecord[] = [];
  const slotStrength: Record<string, number> = {};
  const bases = Object.values(world.truth.base);
  const maxBase = Math.max(...bases);
  for (const [k, v] of Object.entries(world.truth.base)) slotStrength[k] = v / maxBase;
  for (let t = 0; t < world.cfg.historyLength; t++) {
    const product = rng.pick(world.products);
    const daypart = rng.pick(DAYPARTS);
    const strength = slotStrength[`${product.category}|${daypart}`];
    const combo = choosePastCombo(world, strength, rng);
    const { orders, cancelRate } = drawOrders(world.truth, world.cfg, { category: product.category, daypart, combo, t }, rng);
    out.push({
      id: `H${String(t).padStart(4, '0')}`,
      t,
      productId: product.id,
      category: product.category,
      daypart,
      cardLevel: combo.cardLevel,
      giftId: combo.giftId,
      listPrice: product.listPrice,
      marginRate: product.marginRate,
      orders,
      cancelRate: Number(cancelRate.toFixed(3)),
    });
  }
  return out;
}

// 한 회 방송 실행: 담당자가 승인한 조합으로 실적을 만든다.
export function runBroadcast(world: World, sb: ScheduledBroadcast, combo: Combo, drawSeed: number): BroadcastRecord {
  const product = world.products.find((p) => p.id === sb.productId);
  if (!product) throw new Error(`unknown product ${sb.productId}`);
  const rng = makeRng(world.cfg.seed ^ drawSeed);
  const { orders, cancelRate } = drawOrders(world.truth, world.cfg, { category: sb.category, daypart: sb.daypart, combo, t: sb.t }, rng);
  return {
    id: sb.id,
    t: sb.t,
    productId: sb.productId,
    category: sb.category,
    daypart: sb.daypart,
    cardLevel: combo.cardLevel,
    giftId: combo.giftId,
    listPrice: product.listPrice,
    marginRate: product.marginRate,
    orders,
    cancelRate: Number(cancelRate.toFixed(3)),
  };
}

// 참 기대 주문 수(평가 실행기 전용)
export function trueExpected(world: World, sb: Pick<ScheduledBroadcast, 'category' | 'daypart' | 't'>, combo: Combo): number {
  return expectedOrders(world.truth, world.cfg, { category: sb.category, daypart: sb.daypart, combo, t: sb.t });
}

export function makeSchedule(world: World, startT: number, count: number, seed: number, opts?: Partial<Pick<ScheduledBroadcast, 'budget' | 'marginFloor' | 'objective'>>): ScheduledBroadcast[] {
  const rng = makeRng(seed);
  const out: ScheduledBroadcast[] = [];
  for (let i = 0; i < count; i++) {
    const product = rng.pick(world.products);
    out.push({
      id: `S${String(startT + i).padStart(4, '0')}`,
      t: startT + i,
      productId: product.id,
      category: product.category,
      daypart: rng.pick(DAYPARTS),
      budget: opts?.budget ?? Math.round(product.listPrice * 120 * 0.08),
      marginFloor: opts?.marginFloor ?? 0,
      objective: opts?.objective ?? 'margin',
    });
  }
  return out;
}

export const DEV_WORLD: WorldConfig = {
  seed: 20261030,
  misspec: { concaveCard: true, interaction: true, daypartElasticity: true, structuralChange: true, hiddenFactor: true, selectionBias: true, heavyTail: true },
  historyLength: 360,
  changeAt: 300,
  noiseSd: 0.3,
  policy: 'boost-strong',
};

export { CARD_LEVELS, GIFT_IDS };
