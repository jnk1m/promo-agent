// 숨은 참 반응 함수. 추정기와 탐색기는 이 파일을 import 할 수 없다(eslint 규칙).
// 전부 합성이며 어떤 실제 홈쇼핑 수치와도 무관하다.
import { CATEGORIES, DAYPARTS, type Category, type Combo, type Daypart, type GiftId } from '../domain';
import { makeRng, type Rng } from '../rng';

export type Misspec = {
  concaveCard: boolean; // 할인 효과가 오목(수확 체감)
  interaction: boolean; // 상품군별 카드 x 사은품 상호작용
  daypartElasticity: boolean; // 시간대별 사은품 탄력 차이
  structuralChange: boolean; // 후반부 사은품 반응 약화
  hiddenFactor: boolean; // 기록되지 않는 요인(진행자 등)
  selectionBias: boolean; // 과거 조건 선택이 실적과 상관
  heavyTail: boolean; // 두꺼운 꼬리 잡음
};

export const MISSPEC_ALL_ON: Misspec = {
  concaveCard: true,
  interaction: true,
  daypartElasticity: true,
  structuralChange: true,
  hiddenFactor: true,
  selectionBias: true,
  heavyTail: true,
};

export const MISSPEC_ALL_OFF: Misspec = {
  concaveCard: false,
  interaction: false,
  daypartElasticity: false,
  structuralChange: false,
  hiddenFactor: false,
  selectionBias: false,
  heavyTail: false,
};

export type WorldConfig = {
  seed: number;
  misspec: Misspec;
  historyLength: number; // 과거 방송 수
  changeAt: number; // 구조 변화 시점(t)
  noiseSd: number; // 로그 잡음 표준편차
  policy: 'boost-strong' | 'rescue-weak' | 'random'; // 과거 조건 선택 정책(선택 편향)
};

export type Truth = {
  base: Record<string, number>; // slotKey -> 기준 주문 수
  cardGain: Record<Category, number>; // 카드 효과 최대 배율 증분
  cardScale: number; // 오목 정도
  giftLift: Record<Category, Record<GiftId, number>>;
  daypartGiftMul: Record<Daypart, Record<GiftId, number>>;
  interactionMul: Record<Category, number>; // 고가(음수)/저가(양수) 상호작용
  cancelBase: number;
  cancelByGift: Record<GiftId, number>;
  trendPerT: number;
};

export function buildTruth(cfg: WorldConfig): Truth {
  const rng = makeRng(cfg.seed ^ 0x9e3779b9);
  const base: Record<string, number> = {};
  for (const c of CATEGORIES) {
    const catBase = 80 + rng.next() * 220;
    for (const d of DAYPARTS) {
      const dMul = { 아침: 0.7, 낮: 0.9, 저녁: 1.4, 심야: 1.0 }[d];
      base[`${c}|${d}`] = catBase * dMul * (0.8 + rng.next() * 0.4);
    }
  }
  const cardGain = {} as Record<Category, number>;
  const interactionMul = {} as Record<Category, number>;
  const giftLift = {} as Record<Category, Record<GiftId, number>>;
  for (const c of CATEGORIES) {
    cardGain[c] = 0.15 + rng.next() * 0.35; // 10% 할인에서 최대 +15~50%
    interactionMul[c] = rng.next() < 0.5 ? -0.12 : 0.1;
    giftLift[c] = {
      none: 1,
      A: 1 + 0.02 + rng.next() * 0.12,
      B: 1 + 0.05 + rng.next() * 0.3,
      C: 1 + 0.03 + rng.next() * 0.2,
    };
  }
  const daypartGiftMul: Record<Daypart, Record<GiftId, number>> = {
    아침: { none: 1, A: 1.0, B: 0.85, C: 0.95 },
    낮: { none: 1, A: 0.95, B: 0.9, C: 1.0 },
    저녁: { none: 1, A: 1.0, B: 1.1, C: 1.05 },
    심야: { none: 1, A: 1.1, B: 1.25, C: 1.1 },
  };
  return {
    base,
    cardGain,
    cardScale: 5,
    giftLift,
    daypartGiftMul,
    interactionMul,
    cancelBase: 0.08,
    cancelByGift: { none: 0, A: 0.01, B: 0.05, C: 0.02 },
    trendPerT: 0.0004,
  };
}

export type TruthInput = { category: Category; daypart: Daypart; combo: Combo; t: number };

// 잡음 없는 기대 주문 수(참 값). 평가 실행기만 쓴다.
export function expectedOrders(truth: Truth, cfg: WorldConfig, x: TruthInput, hidden = 1): number {
  const { category, daypart, combo, t } = x;
  const m = cfg.misspec;
  const base = truth.base[`${category}|${daypart}`];
  const trend = 1 + truth.trendPerT * t;
  const lvl = combo.cardLevel;
  const cardEffect = m.concaveCard
    ? 1 + truth.cardGain[category] * (1 - Math.exp(-lvl / truth.cardScale)) / (1 - Math.exp(-10 / truth.cardScale))
    : 1 + truth.cardGain[category] * (lvl / 10);
  let giftEffect = truth.giftLift[category][combo.giftId];
  if (m.daypartElasticity) giftEffect = 1 + (giftEffect - 1) * truth.daypartGiftMul[daypart][combo.giftId];
  if (m.structuralChange && t >= cfg.changeAt && combo.giftId !== 'none') giftEffect = 1 + (giftEffect - 1) * 0.6;
  let inter = 1;
  if (m.interaction && combo.giftId !== 'none' && lvl > 0) inter = 1 + truth.interactionMul[category] * (lvl / 10);
  return base * trend * cardEffect * giftEffect * inter * hidden;
}

export function trueCancelRate(truth: Truth, combo: Combo): number {
  return truth.cancelBase + truth.cancelByGift[combo.giftId];
}

// 실제 관측 주문 수(잡음 포함)
export function drawOrders(truth: Truth, cfg: WorldConfig, x: TruthInput, rng: Rng): { orders: number; cancelRate: number; hidden: number } {
  const m = cfg.misspec;
  const hidden = m.hiddenFactor ? Math.exp(rng.normal(0, 0.25)) : 1;
  const mu = expectedOrders(truth, cfg, x, hidden);
  const eps = m.heavyTail ? rng.studentT(4) * cfg.noiseSd * 0.8 : rng.normal(0, cfg.noiseSd);
  const orders = Math.max(0, Math.round(mu * Math.exp(eps)));
  const cancelRate = Math.min(0.5, Math.max(0, trueCancelRate(truth, combo(x)) + rng.normal(0, 0.015)));
  return { orders, cancelRate, hidden };
}

function combo(x: TruthInput): Combo {
  return x.combo;
}
