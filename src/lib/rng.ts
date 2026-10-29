// 시드 고정 난수. 같은 시드면 같은 세계.
export type Rng = {
  next: () => number; // [0,1)
  normal: (mean?: number, sd?: number) => number;
  studentT: (df: number) => number;
  int: (lo: number, hi: number) => number; // [lo, hi]
  pick: <T>(arr: readonly T[]) => T;
};

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (mean = 0, sd = 1) => {
    let u = 0;
    let v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const gamma = (k: number): number => {
    // Marsaglia-Tsang, k >= 1
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x = normal();
      let v = 1 + c * x;
      if (v <= 0) continue;
      v = v * v * v;
      const u = next();
      x = x * x;
      if (u < 1 - 0.0331 * x * x) return d * v;
      if (Math.log(u) < 0.5 * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const studentT = (df: number) => {
    const z = normal();
    const chi = 2 * gamma(df / 2);
    return z / Math.sqrt(chi / df);
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(arr: readonly T[]) => arr[int(0, arr.length - 1)];
  return { next, normal, studentT, int, pick };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
