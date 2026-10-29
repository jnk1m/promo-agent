// 추정기의 설계 행렬. 참 함수를 모른다.
import { CARD_LEVELS, CATEGORIES, DAYPARTS, GIFT_IDS, type Category, type Combo, type Daypart } from '../domain';

export type FeatureIndex = { names: string[]; index: Record<string, number> };

export function buildFeatureIndex(): FeatureIndex {
  const names: string[] = [];
  for (const c of CATEGORIES) for (const d of DAYPARTS) names.push(`cell:${c}|${d}`);
  for (const l of CARD_LEVELS) if (l !== 0) names.push(`card:${l}`);
  for (const g of GIFT_IDS) if (g !== 'none') names.push(`gift:${g}`);
  for (const c of CATEGORIES) for (const l of CARD_LEVELS) if (l !== 0) names.push(`catcard:${c}|${l}`);
  for (const c of CATEGORIES) for (const g of GIFT_IDS) if (g !== 'none') names.push(`catgift:${c}|${g}`);
  for (const l of CARD_LEVELS) if (l !== 0) for (const g of GIFT_IDS) if (g !== 'none') names.push(`cardgift:${l}|${g}`);
  const index: Record<string, number> = {};
  names.forEach((n, i) => (index[n] = i));
  return { names, index };
}

export type FeatureInput = { category: Category; daypart: Daypart; combo: Combo };

export function featurize(fi: FeatureIndex, x: FeatureInput): number[] {
  const v = new Array<number>(fi.names.length).fill(0);
  v[fi.index[`cell:${x.category}|${x.daypart}`]] = 1;
  const l = x.combo.cardLevel;
  const g = x.combo.giftId;
  if (l !== 0) {
    v[fi.index[`card:${l}`]] = 1;
    v[fi.index[`catcard:${x.category}|${l}`]] = 1;
  }
  if (g !== 'none') {
    v[fi.index[`gift:${g}`]] = 1;
    v[fi.index[`catgift:${x.category}|${g}`]] = 1;
  }
  if (l !== 0 && g !== 'none') v[fi.index[`cardgift:${l}|${g}`]] = 1;
  return v;
}

// 사전분포. 칸 기준값은 넓게, 공유 효과는 중간, 상품군별 조정과 상호작용은 좁게(0 근처).
export function priorSd(name: string): number {
  if (name.startsWith('cell:')) return 1.5;
  if (name.startsWith('card:') || name.startsWith('gift:')) return 0.3;
  if (name.startsWith('catcard:') || name.startsWith('catgift:')) return 0.15;
  return 0.1; // cardgift
}

export function priorMean(name: string): number {
  if (name.startsWith('cell:')) return Math.log(120);
  return 0;
}
