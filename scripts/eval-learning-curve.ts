// 봉인된 평가 세계 48개로 학습 곡선을 돌려 eval/results/learning-curve.json 에 저장한다.
// 결과가 나쁘면 나쁜 대로 저장한다. 세계를 결과에 맞춰 바꾸지 않는다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runSeed, summarize, type SeedResult } from '../src/lib/eval/learning-curve';
import type { WorldConfig } from '../src/lib/world/truth';

const BROADCASTS = Number(process.env.BROADCASTS ?? 24);
const raw = readFileSync('eval/worlds.json');
const hash = createHash('sha256').update(raw).digest('hex');
const sealed = readFileSync('eval/SEAL.md', 'utf8');
if (!sealed.includes(hash)) throw new Error(`eval/worlds.json hash ${hash.slice(0, 12)} is not the sealed one`);
const worlds = (JSON.parse(raw.toString()) as { worlds: { name: string; cfg: WorldConfig }[] }).worlds;

const results: SeedResult[] = [];
const t0 = Date.now();
for (const w of worlds) {
  results.push(runSeed(w.name, w.cfg, BROADCASTS));
  process.stdout.write('.');
}
console.log(`\n${worlds.length} worlds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const summary = summarize(results, BROADCASTS);
mkdirSync('eval/results', { recursive: true });
writeFileSync(`eval/results/learning-curve-${BROADCASTS}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), worldsHash: hash, summary, results }, null, 1));
// 화면용 요약(시드별 상세 제외)
const summaryPath = 'eval/results/summary.json';
const all = existsSync(summaryPath) ? (JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, unknown>) : {};
all[String(BROADCASTS)] = { generatedAt: new Date().toISOString(), worldsHash: hash, summary };
writeFileSync(summaryPath, JSON.stringify(all, null, 1));
for (const g of ['on', 'off'] as const) {
  const s = summary.groups[g];
  console.log(`\n어긋남 ${g === 'on' ? '켬' : '끔'} (시드 ${s.seeds}개, 방송 ${BROADCASTS}회 누적 손실, 참 기대 마진 기준, 원)`);
  for (const k of ['updating', 'frozen', 'copy_last', 'random'] as const) console.log(`  ${k.padEnd(10)} 평균 ${Math.round(s.meanTotal[k]).toLocaleString()}  최악 ${Math.round(s.worstTotal[k]).toLocaleString()}`);
  console.log(`  갱신 켠 에이전트가 끈 에이전트를 이긴 시드 ${s.updatingBeatsFrozen}/${s.seeds}, 직전 복사를 이긴 시드 ${s.updatingBeatsCopy}/${s.seeds}`);
}
