// 작은 선형대수. 대칭 양정치 행렬 전용.
export type Mat = number[][];

export function zeros(n: number, m = n): Mat {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

export function cholesky(a: Mat): Mat {
  const n = a.length;
  const L = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 0) throw new Error(`cholesky: not positive definite at ${i} (${s})`);
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

// A x = b 를 촐레스키로 푼다
export function solveChol(L: Mat, b: number[]): number[] {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

export function invertSpd(a: Mat): Mat {
  const n = a.length;
  const L = cholesky(a);
  const inv = zeros(n);
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    const col = solveChol(L, e);
    for (let i = 0; i < n; i++) inv[i][j] = col[i];
  }
  return inv;
}

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function matVec(a: Mat, v: number[]): number[] {
  return a.map((row) => dot(row, v));
}

export function quad(a: Mat, v: number[]): number {
  return dot(v, matVec(a, v));
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
