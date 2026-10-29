// 조합 전수 계산과 순위. 전부 코드. 같은 입력이면 같은 결과.
import { allCombos, comboKey, money, type Combo, type Menu, type Product, type ScheduledBroadcast } from '../domain';
import { comboCount, posterior, sampleCoefs, sampleOrders, type ModelState } from '../estimate/model';
import { quantile } from '../estimate/linalg';
import { applicableConstraints, comboAllowed, type Constraint } from '../ledger/constraints';

export type Interval = { p10: number; p50: number; p90: number };

export type ComboEval = {
  combo: Combo;
  key: string;
  orders: Interval;
  revenue: Interval;
  promoCost: Interval;
  margin: Interval;
  pBest: number; // 실행 가능한 조합 중 목표 기준 1위일 확률
  feasible: boolean;
  infeasibleReasons: string[];
  sampleCount: number; // 이 칸에서 이 조합의 과거 방송 수
  rank: number; // 실행 가능 조합 중 순위(1부터). 불가면 0
};

export type SearchResult = {
  evals: ComboEval[];
  feasibleCount: number;
  appliedConstraints: Constraint[];
  releasedConstraint: Constraint | null; // 후보 0개가 되어 마지막 제약을 푼 경우
  objective: 'revenue' | 'margin';
};

const K = 400;

function iv(vals: number[]): Interval {
  const s = vals.slice().sort((a, b) => a - b);
  return { p10: quantile(s, 0.1), p50: quantile(s, 0.5), p90: quantile(s, 0.9) };
}

export function searchCombos(model: ModelState, sb: ScheduledBroadcast, product: Product, menu: Menu, ledger: Constraint[], seed = 1): SearchResult {
  const post = posterior(model);
  const draws = sampleCoefs(post, K, seed);
  let applied = applicableConstraints(ledger, sb);
  let releasedConstraint: Constraint | null = null;

  const evaluate = (cs: Constraint[]) => {
    const combos = allCombos();
    const per = combos.map((combo, i) => {
      const orders = sampleOrders(post, model, { category: sb.category, daypart: sb.daypart, combo }, draws, seed + i);
      const cancel = 0.08; // 취소율은 사후 추정에 넣지 않았다(가정값). 화면에 가정 표시.
      const monies = orders.map((o) => money(o, cancel, product, combo, menu));
      const rev = monies.map((m) => m.revenue);
      const cost = monies.map((m) => m.promoCost);
      const mar = monies.map((m) => m.margin);
      const reasons: string[] = [];
      if (!comboAllowed(combo, cs)) reasons.push('활성 제약에 걸림');
      const costIv = iv(cost);
      const marIv = iv(mar);
      if (costIv.p50 > sb.budget) reasons.push('예산 초과(비용 중앙값)');
      if (marIv.p50 < sb.marginFloor) reasons.push('마진 하한 미달(중앙값)');
      return { combo, key: comboKey(combo), orders: iv(orders), revenue: iv(rev), promoCost: costIv, margin: marIv, feasible: reasons.length === 0, infeasibleReasons: reasons, sampleCount: comboCount(model, sb.category, sb.daypart, combo), perDraw: sb.objective === 'margin' ? mar : rev };
    });
    return per;
  };

  let per = evaluate(applied);
  if (per.every((p) => !p.feasible) && applied.length > 0) {
    // 후보 0개: 마지막 제약을 풀고 알린다(R10)
    releasedConstraint = applied[applied.length - 1];
    applied = applied.slice(0, -1);
    per = evaluate(applied);
  }

  const feasible = per.filter((p) => p.feasible);
  const bestCounts = new Array<number>(per.length).fill(0);
  if (feasible.length > 0) {
    for (let d = 0; d < K; d++) {
      let bi = -1;
      let bv = -Infinity;
      per.forEach((p, i) => {
        if (!p.feasible) return;
        if (p.perDraw[d] > bv) {
          bv = p.perDraw[d];
          bi = i;
        }
      });
      if (bi >= 0) bestCounts[bi] += 1;
    }
  }
  const objKey = sb.objective;
  const order = per
    .map((p, i) => ({ i, v: p[objKey].p50, f: p.feasible }))
    .filter((o) => o.f)
    .sort((a, b) => b.v - a.v);
  const rankOf = new Map<number, number>();
  order.forEach((o, r) => rankOf.set(o.i, r + 1));

  const evals: ComboEval[] = per.map((p, i) => ({
    combo: p.combo,
    key: p.key,
    orders: p.orders,
    revenue: p.revenue,
    promoCost: p.promoCost,
    margin: p.margin,
    pBest: bestCounts[i] / K,
    feasible: p.feasible,
    infeasibleReasons: p.infeasibleReasons,
    sampleCount: p.sampleCount,
    rank: rankOf.get(i) ?? 0,
  }));
  evals.sort((a, b) => (a.rank || 99) - (b.rank || 99));
  return { evals, feasibleCount: feasible.length, appliedConstraints: applied, releasedConstraint, objective: sb.objective };
}
