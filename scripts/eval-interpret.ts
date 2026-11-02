// 수정 이유 해석 정확도: 봉인된 문장 50개로 모델 해석기와 낱말 규칙 기준선을 같은 기대값에 대조한다.
// 실행: node --env-file=.env.local --import tsx scripts/eval-interpret.ts   (SKIP_MODEL=1 이면 기준선만)
// 결과가 나쁘면 나쁜 대로 eval/results/interpret-accuracy.json 에 저장한다. 문장을 결과에 맞춰 바꾸지 않는다.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CATEGORIES, DEFAULT_MENU, type ScheduledBroadcast } from '../src/lib/domain';
import { validateInterpretation, type Interpretation } from '../src/lib/ledger/constraints';
import { createEnvClient } from '../src/lib/llm/client';
import { interpretReason } from '../src/lib/llm/interpret';
import { keywordInterpret } from '../src/lib/llm/keyword-parser';

type Sentence = { id: string; text: string; broadcast: Pick<ScheduledBroadcast, 'id' | 't' | 'category' | 'daypart' | 'productId'>; expected: Interpretation };
type Grade = 'exact' | 'kind_only' | 'safe_miss' | 'harmful';
type Outcome = { grade: Grade; predicted: Interpretation | null; attempts: number; rejected: string[]; ms: number };

const raw = readFileSync('eval/reason-sentences.json');
const hash = createHash('sha256').update(raw).digest('hex');
if (!readFileSync('eval/SEAL.md', 'utf8').includes(hash)) throw new Error(`eval/reason-sentences.json hash ${hash.slice(0, 12)} is not the sealed one`);
const sentences = (JSON.parse(raw.toString()) as { sentences: Sentence[] }).sentences;
const knownProductIds = CATEGORIES.flatMap((c) => [1, 2, 3].map((i) => `${c}-${i}`));
const isConstraint = (k: Interpretation['kind']) => k === 'ban_gift' || k === 'cap_card' || k === 'require_gift';

function same(a: Interpretation, b: Interpretation): boolean {
  if (a.kind !== b.kind) return false;
  if (!isConstraint(a.kind)) return true; // 메모와 해석불가는 종류만 본다
  const sc = (a.scope.category ?? '') === (b.scope.category ?? '') && (a.scope.daypart ?? '') === (b.scope.daypart ?? '') && (a.scope.productId ?? '') === (b.scope.productId ?? '');
  const tg = (a.target.giftId ?? '') === (b.target.giftId ?? '') && (a.target.maxCardLevel ?? -1) === (b.target.maxCardLevel ?? -1);
  const du = a.duration.type === b.duration.type && (a.duration.type !== 'until_t' || b.duration.type !== 'until_t' || a.duration.t === b.duration.t);
  return sc && tg && du;
}

// 등급: exact(전부 일치) / kind_only(종류만 일치) / safe_miss(제약을 만들지 않아 해가 없음) / harmful(틀린 제약이 만들어지거나, 제약이 아닌 문장에서 제약이 생김)
function grade(expected: Interpretation, predicted: Interpretation | null): Grade {
  if (!predicted || !isConstraint(predicted.kind)) {
    if (!isConstraint(expected.kind)) return predicted && predicted.kind === expected.kind ? 'exact' : 'safe_miss';
    return 'safe_miss';
  }
  if (!isConstraint(expected.kind)) return 'harmful';
  if (same(expected, predicted)) return 'exact';
  return expected.kind === predicted.kind ? 'kind_only' : 'harmful';
}

function toSb(b: Sentence['broadcast']): ScheduledBroadcast {
  return { ...b, budget: 1e12, marginFloor: -1e12, objective: 'margin' };
}

async function main() {
  const skipModel = process.env.SKIP_MODEL === '1';
  const client = skipModel ? null : await createEnvClient();
  const rows: { id: string; text: string; expectedKind: Interpretation['kind']; keyword: Outcome; model: Outcome | null }[] = [];
  for (const s of sentences) {
    const sb = toSb(s.broadcast);
    const t0 = Date.now();
    const kw = keywordInterpret(s.text, sb, DEFAULT_MENU);
    const kwErrors = validateInterpretation(kw, s.text, sb, knownProductIds);
    const keyword: Outcome = { grade: grade(s.expected, kwErrors.length ? null : kw), predicted: kw, attempts: 1, rejected: kwErrors, ms: Date.now() - t0 };
    let model: Outcome | null = null;
    if (client) {
      const t1 = Date.now();
      const r = await interpretReason(client, s.text, sb, DEFAULT_MENU, knownProductIds);
      const predicted = r.ok ? r.interpretation : null;
      model = { grade: grade(s.expected, predicted), predicted: r.ok ? r.interpretation : (r.last ?? null), attempts: r.attempts, rejected: r.ok ? [] : r.errors, ms: Date.now() - t1 };
    }
    rows.push({ id: s.id, text: s.text, expectedKind: s.expected.kind, keyword, model });
    process.stdout.write(model ? (model.grade === 'exact' ? '.' : model.grade === 'harmful' ? 'X' : 'o') : keyword.grade === 'exact' ? '.' : 'o');
  }
  console.log();

  const count = (pick: (r: (typeof rows)[number]) => Outcome | null) => {
    const c: Record<Grade, number> = { exact: 0, kind_only: 0, safe_miss: 0, harmful: 0 };
    const byKind: Record<string, { n: number; exact: number }> = {};
    let rejectedRuns = 0;
    for (const r of rows) {
      const o = pick(r);
      if (!o) continue;
      c[o.grade] += 1;
      byKind[r.expectedKind] ??= { n: 0, exact: 0 };
      byKind[r.expectedKind].n += 1;
      if (o.grade === 'exact') byKind[r.expectedKind].exact += 1;
      if (o.rejected.length) rejectedRuns += 1;
    }
    return { ...c, byKind, rejectedRuns };
  };
  const summary = { n: rows.length, keyword: count((r) => r.keyword), model: client ? { id: client.id, ...count((r) => r.model) } : null };
  mkdirSync('eval/results', { recursive: true });
  writeFileSync('eval/results/interpret-accuracy.json', JSON.stringify({ generatedAt: new Date().toISOString(), sentencesHash: hash, summary, rows }, null, 1));

  const show = (name: string, c: ReturnType<typeof count>) => {
    console.log(`${name}: 전부 일치 ${c.exact}/${rows.length}, 종류만 ${c.kind_only}, 안전한 놓침 ${c.safe_miss}, 해로운 오해석 ${c.harmful}, 검증 거부 ${c.rejectedRuns}`);
    for (const [k, v] of Object.entries(c.byKind)) console.log(`  ${k.padEnd(13)} ${v.exact}/${v.n}`);
  };
  show('낱말 규칙 기준선', summary.keyword);
  if (summary.model) show(`모델 ${summary.model.id}`, summary.model);
  for (const r of rows) {
    const o = r.model ?? r.keyword;
    if (o.grade !== 'exact') console.log(`  ${r.id} [${o.grade}] "${r.text}" 기대 ${r.expectedKind} -> ${o.predicted ? JSON.stringify({ kind: o.predicted.kind, scope: o.predicted.scope, target: o.predicted.target, duration: o.predicted.duration }) : 'null'}${o.rejected.length ? ' 거부: ' + o.rejected.join('; ') : ''}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
