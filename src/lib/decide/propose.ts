// 결정안(숫자 부분). 문장은 llm/ 에서 슬롯으로 채운다.
import type { Combo, Menu, Product, ScheduledBroadcast } from '../domain';
import { cellCount, type ModelState } from '../estimate/model';
import type { Constraint } from '../ledger/constraints';
import { searchCombos, type ComboEval, type SearchResult } from '../search/combos';

export type LowConfidence = { code: 'wide_interval' | 'few_samples' | 'low_pbest' | 'cell_sparse'; detail: string };

export type Alternative = { eval: ComboEval; whyNot: string[] };

export type Proposal = {
  broadcastId: string;
  chosen: ComboEval | null;
  alternatives: Alternative[];
  lowConfidence: LowConfidence[];
  appliedConstraintIds: string[];
  releasedConstraintId: string | null;
  feasibleCount: number;
  cellSamples: number;
  objective: 'revenue' | 'margin';
  search: SearchResult;
};

export function propose(model: ModelState, sb: ScheduledBroadcast, product: Product, menu: Menu, ledger: Constraint[], seed = 1): Proposal {
  const search = searchCombos(model, sb, product, menu, ledger, seed);
  const feasible = search.evals.filter((e) => e.feasible);
  const chosen = feasible[0] ?? null;
  const objKey = sb.objective;
  const alternatives: Alternative[] = feasible.slice(1, 3).map((e) => {
    const why: string[] = [];
    if (chosen) {
      const gap = chosen[objKey].p50 - e[objKey].p50;
      why.push(`목표 중앙값이 1위보다 낮음 (차이 ${Math.round(gap).toLocaleString()}원)`);
      if (e.margin.p10 < chosen.margin.p10) why.push('마진 구간 하한이 더 낮음');
      if (e.pBest < chosen.pBest) why.push(`1위 확률이 더 낮음 (${(e.pBest * 100).toFixed(0)}%)`);
    }
    return { eval: e, whyNot: why };
  });
  const low: LowConfidence[] = [];
  const cellSamples = cellCount(model, sb.category, sb.daypart);
  if (chosen) {
    const width = chosen.orders.p90 / Math.max(1, chosen.orders.p10);
    if (width > 2.5) low.push({ code: 'wide_interval', detail: `주문 수 구간이 넓음 (상한/하한 ${width.toFixed(1)}배)` });
    if (chosen.sampleCount < 3) low.push({ code: 'few_samples', detail: `이 칸에서 이 조합의 과거 방송 ${chosen.sampleCount}건` });
    if (chosen.pBest < 0.5) low.push({ code: 'low_pbest', detail: `1위일 확률 ${(chosen.pBest * 100).toFixed(0)}%` });
  }
  if (cellSamples < 5) low.push({ code: 'cell_sparse', detail: `이 상품군 x 시간대의 과거 방송 ${cellSamples}건` });
  return {
    broadcastId: sb.id,
    chosen,
    alternatives,
    lowConfidence: low,
    appliedConstraintIds: search.appliedConstraints.map((c) => c.id),
    releasedConstraintId: search.releasedConstraint?.id ?? null,
    feasibleCount: search.feasibleCount,
    cellSamples,
    objective: sb.objective,
    search,
  };
}

export function sameCombo(a: Combo, b: Combo): boolean {
  return a.cardLevel === b.cardLevel && a.giftId === b.giftId;
}
