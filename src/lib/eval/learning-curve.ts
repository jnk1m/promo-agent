// 학습 곡선(T7): 갱신 켠 에이전트 대 끈 에이전트 대 기준선. 평가 실행기이므로 참 함수를 읽는다.
// 손실(regret) = 참 기대 마진 기준 최선 조합의 마진 - 실제 고른 조합의 참 기대 마진. 합성 세계 안의 값이다.
import { allCombos, DEFAULT_MENU, money, type BroadcastRecord, type Combo, type Product, type ScheduledBroadcast } from '../domain';
import { makeRng } from '../rng';
import { propose } from '../decide/propose';
import { initModel, updateMany, updateOne, type ModelState } from '../estimate/model';
import { applicableConstraints, comboAllowed, type Constraint } from '../ledger/constraints';
import { generateHistory, makeSchedule, makeWorld, runBroadcast, trueExpected, type World } from '../world/generate';
import { trueCancelRate } from '../world/truth';
import type { WorldConfig } from '../world/truth';

export type AgentKind = 'updating' | 'frozen' | 'copy_last' | 'random';

export type CurvePoint = { i: number; regret: number };
export type SeedResult = { name: string; seed: number; misspecOn: boolean; perAgent: Record<AgentKind, { regrets: number[]; total: number; modifiedCount: number }> };

function trueMargin(world: World, sb: ScheduledBroadcast, product: Product, combo: Combo): number {
  const e = trueExpected(world, sb, combo);
  return money(e, trueCancelRate(world.truth, combo), product, combo, DEFAULT_MENU).margin;
}

// 가상 담당자: 믿음 규칙 일부는 참 함수와 맞고 일부는 틀리다. 합성이며 대본이다.
type Belief = { category: string; banGift: Combo['giftId']; correct: boolean };

function makeBeliefs(world: World, rng: ReturnType<typeof makeRng>): Belief[] {
  const beliefs: Belief[] = [];
  for (const c of Object.keys(world.truth.giftLift) as (keyof typeof world.truth.giftLift)[]) {
    const lifts = world.truth.giftLift[c];
    const weakest = (['A', 'B', 'C'] as const).reduce((a, b) => (lifts[a] < lifts[b] ? a : b));
    const strongest = (['A', 'B', 'C'] as const).reduce((a, b) => (lifts[a] > lifts[b] ? a : b));
    if (rng.next() < 0.5) beliefs.push({ category: c, banGift: weakest, correct: true });
    else if (rng.next() < 0.5) beliefs.push({ category: c, banGift: strongest, correct: false });
  }
  return beliefs;
}

function beliefConstraint(b: Belief, sb: ScheduledBroadcast, id: string): Constraint {
  return { id, kind: 'ban_gift', scope: { category: b.category as Constraint['scope']['category'] }, target: { giftId: b.banGift }, duration: { type: 'always' }, quote: '대본', sourceText: '가상 담당자 믿음 규칙(대본)', confidence: 'high', status: 'active', createdAtT: sb.t, createdForBroadcastId: sb.id };
}

export function runSeed(name: string, cfg: WorldConfig, broadcasts = 24): SeedResult {
  const world = makeWorld(cfg);
  const history = generateHistory(world);
  const base = updateMany(initModel(), history);
  const schedule = makeSchedule(world, cfg.historyLength, broadcasts, cfg.seed ^ 0x5151, { budget: 1e12, marginFloor: -1e12, objective: 'margin' });
  const rng = makeRng(cfg.seed ^ 0x2222);
  const beliefs = makeBeliefs(world, rng);
  const productOf = (id: string) => world.products.find((p) => p.id === id)!;

  const perAgent = {} as SeedResult['perAgent'];
  for (const kind of ['updating', 'frozen', 'copy_last', 'random'] as AgentKind[]) {
    let model: ModelState = base;
    let ledger: Constraint[] = [];
    const lastInCell = new Map<string, Combo>();
    for (const r of history) lastInCell.set(`${r.category}|${r.daypart}`, { cardLevel: r.cardLevel, giftId: r.giftId });
    const regrets: number[] = [];
    let modifiedCount = 0;
    const arng = makeRng(cfg.seed ^ 0x3333);
    schedule.forEach((sb) => {
      const product = productOf(sb.productId);
      const bestTrue = Math.max(...allCombos().map((c) => trueMargin(world, sb, product, c)));
      let combo: Combo;
      if (kind === 'random') combo = arng.pick(allCombos());
      else if (kind === 'copy_last') combo = lastInCell.get(`${sb.category}|${sb.daypart}`) ?? { cardLevel: 0, giftId: 'none' };
      else {
        const p = propose(model, sb, product, DEFAULT_MENU, ledger, 1);
        combo = p.chosen?.combo ?? { cardLevel: 0, giftId: 'none' };
        // 가상 담당자: 믿음에 걸리면 고치고 제약을 올린다(해석기 없이 대본으로 바로 제약)
        const b = beliefs.find((x) => x.category === sb.category && x.banGift === combo.giftId);
        if (b) {
          modifiedCount += 1;
          if (!ledger.some((c) => c.scope.category === b.category && c.target.giftId === b.banGift)) ledger = [...ledger, beliefConstraint(b, sb, `C${ledger.length + 1}`)];
          const cs = applicableConstraints(ledger, sb);
          const alt = p.search.evals.find((e) => e.feasible && comboAllowed(e.combo, cs));
          combo = alt?.combo ?? combo;
        }
      }
      regrets.push(bestTrue - trueMargin(world, sb, product, combo));
      const record: BroadcastRecord = runBroadcast(world, sb, combo, sb.t * 17 + 1);
      if (kind === 'updating') model = updateOne(model, record);
      lastInCell.set(`${sb.category}|${sb.daypart}`, combo);
    });
    perAgent[kind] = { regrets, total: regrets.reduce((a, b) => a + b, 0), modifiedCount };
  }
  return { name, seed: cfg.seed, misspecOn: cfg.misspec.concaveCard, perAgent };
}

export type CurveSummary = {
  broadcasts: number;
  groups: Record<'on' | 'off', { seeds: number; meanTotal: Record<AgentKind, number>; worstTotal: Record<AgentKind, number>; curve: Record<AgentKind, number[]>; updatingBeatsFrozen: number; updatingBeatsCopy: number }>;
};

export function summarize(results: SeedResult[], broadcasts: number): CurveSummary {
  const groups = {} as CurveSummary['groups'];
  for (const g of ['on', 'off'] as const) {
    const rs = results.filter((r) => r.misspecOn === (g === 'on'));
    const kinds: AgentKind[] = ['updating', 'frozen', 'copy_last', 'random'];
    const meanTotal = {} as Record<AgentKind, number>;
    const worstTotal = {} as Record<AgentKind, number>;
    const curve = {} as Record<AgentKind, number[]>;
    for (const k of kinds) {
      const totals = rs.map((r) => r.perAgent[k].total);
      meanTotal[k] = totals.reduce((a, b) => a + b, 0) / Math.max(1, totals.length);
      worstTotal[k] = Math.max(...totals);
      curve[k] = Array.from({ length: broadcasts }, (_, i) => rs.reduce((a, r) => a + r.perAgent[k].regrets[i], 0) / Math.max(1, rs.length));
    }
    groups[g] = {
      seeds: rs.length,
      meanTotal,
      worstTotal,
      curve,
      updatingBeatsFrozen: rs.filter((r) => r.perAgent.updating.total < r.perAgent.frozen.total).length,
      updatingBeatsCopy: rs.filter((r) => r.perAgent.updating.total < r.perAgent.copy_last.total).length,
    };
  }
  return { broadcasts, groups };
}
