// 로그 주문 수의 정규 베이지안 선형 모델. 정밀도 형태(P = V^-1, b = V^-1 m)로 보관해 갱신이 덧셈이다.
// 순서 불변, 영 증거 불변, 한 건 기여 계산이 따라온다. 잡음 분산은 고정(한계: 데이터로 추정하지 않음).
import type { BroadcastRecord, Combo, Category, Daypart } from '../domain';
import { buildFeatureIndex, featurize, priorMean, priorSd, type FeatureIndex } from './features';
import { cholesky, invertSpd, matVec, quad, type Mat, zeros } from './linalg';
import { makeRng } from '../rng';

export type ModelState = {
  P: Mat; // 정밀도 행렬
  b: number[]; // P * m
  sigma2: number; // 잡음 분산(로그 척도)
  n: number; // 반영한 실적 수
  cellCounts: Record<string, number>; // slotKey -> 표본 수
  comboCounts: Record<string, number>; // slotKey|comboKey -> 표본 수
};

export const NOISE_SD = 0.35;

let cachedFi: FeatureIndex | null = null;
export function fi(): FeatureIndex {
  if (!cachedFi) cachedFi = buildFeatureIndex();
  return cachedFi;
}

export function initModel(): ModelState {
  const f = fi();
  const n = f.names.length;
  const P = zeros(n);
  const b = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const sd = priorSd(f.names[i]);
    P[i][i] = 1 / (sd * sd);
    b[i] = P[i][i] * priorMean(f.names[i]);
  }
  return { P, b, sigma2: NOISE_SD * NOISE_SD, n: 0, cellCounts: {}, comboCounts: {} };
}

export function cloneModel(m: ModelState): ModelState {
  return {
    P: m.P.map((r) => r.slice()),
    b: m.b.slice(),
    sigma2: m.sigma2,
    n: m.n,
    cellCounts: { ...m.cellCounts },
    comboCounts: { ...m.comboCounts },
  };
}

function yOf(r: BroadcastRecord): number {
  return Math.log(r.orders + 1);
}

// 실적 한 건 반영(새 상태를 돌려준다)
export function updateOne(m: ModelState, r: BroadcastRecord): ModelState {
  const out = cloneModel(m);
  const x = featurize(fi(), { category: r.category, daypart: r.daypart, combo: { cardLevel: r.cardLevel, giftId: r.giftId } });
  const y = yOf(r);
  const w = 1 / m.sigma2;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === 0) continue;
    out.b[i] += w * x[i] * y;
    for (let j = 0; j < x.length; j++) if (x[j] !== 0) out.P[i][j] += w * x[i] * x[j];
  }
  out.n += 1;
  const sk = `${r.category}|${r.daypart}`;
  out.cellCounts[sk] = (out.cellCounts[sk] ?? 0) + 1;
  const ck = `${sk}|card${r.cardLevel}_${r.giftId}`;
  out.comboCounts[ck] = (out.comboCounts[ck] ?? 0) + 1;
  return out;
}

export function updateMany(m: ModelState, rs: BroadcastRecord[]): ModelState {
  return rs.reduce((acc, r) => updateOne(acc, r), m);
}

export type Posterior = { mean: number[]; cov: Mat; chol: Mat };

export function posterior(m: ModelState): Posterior {
  const cov = invertSpd(m.P);
  const mean = matVec(cov, m.b);
  return { mean, cov, chol: cholesky(cov) };
}

export type PredictInput = { category: Category; daypart: Daypart; combo: Combo };

// 예측 분포(로그 척도)의 평균과 분산
export function predictLog(post: Posterior, m: ModelState, x: PredictInput): { mu: number; v: number } {
  const f = featurize(fi(), x);
  let mu = 0;
  for (let i = 0; i < f.length; i++) mu += f[i] * post.mean[i];
  const v = quad(post.cov, f) + m.sigma2;
  return { mu, v };
}

// 사후 계수 표본 K개(같은 표본을 여러 조합에 써야 1위 확률이 일관된다)
export function sampleCoefs(post: Posterior, k: number, seed: number): number[][] {
  const rng = makeRng(seed);
  const n = post.mean.length;
  const out: number[][] = [];
  for (let s = 0; s < k; s++) {
    const z = Array.from({ length: n }, () => rng.normal());
    const draw = post.mean.slice();
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j <= i; j++) acc += post.chol[i][j] * z[j];
      draw[i] += acc;
    }
    out.push(draw);
  }
  return out;
}

// 표본마다의 주문 수(잡음 포함)
export function sampleOrders(post: Posterior, m: ModelState, x: PredictInput, coefDraws: number[][], seed: number): number[] {
  const rng = makeRng(seed ^ 0x77);
  const f = featurize(fi(), x);
  const sd = Math.sqrt(m.sigma2);
  return coefDraws.map((beta) => {
    let mu = 0;
    for (let i = 0; i < f.length; i++) if (f[i] !== 0) mu += f[i] * beta[i];
    return Math.max(0, Math.exp(mu + rng.normal(0, sd)) - 1);
  });
}

export function cellCount(m: ModelState, category: Category, daypart: Daypart): number {
  return m.cellCounts[`${category}|${daypart}`] ?? 0;
}

export function comboCount(m: ModelState, category: Category, daypart: Daypart, combo: Combo): number {
  return m.comboCounts[`${category}|${daypart}|card${combo.cardLevel}_${combo.giftId}`] ?? 0;
}
