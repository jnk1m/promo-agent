// 실제 모델로 해석과 결정안 문장을 한 번씩 호출한다. node --env-file=.env.local --import tsx scripts/llm-smoke.ts
import { DEFAULT_MENU } from '../src/lib/domain';
import { DEV_WORLD, generateHistory, makeSchedule, makeWorld } from '../src/lib/world/generate';
import { initState, proposeFor } from '../src/lib/state';
import { createEnvClient } from '../src/lib/llm/client';
import { explainProposal } from '../src/lib/llm/explain';
import { describeInterpretation, interpretReason } from '../src/lib/llm/interpret';

async function main() {
const world = makeWorld(DEV_WORLD);
const state = initState(generateHistory(world), world.products, DEFAULT_MENU);
const sb = makeSchedule(world, 400, 1, 3)[0];
const client = await createEnvClient();
console.log('model', client.id);
const p = proposeFor(state, sb);
const t0 = Date.now();
const ex = await explainProposal(client, p, DEFAULT_MENU);
console.log(`explain: ${ex.source} attempts=${ex.attempts} rejected=${JSON.stringify(ex.rejected)} ${Date.now() - t0}ms`);
console.log(ex.filled.why, '\n', ex.filled.alternatives.join('\n'), '\n', ex.filled.caution);
for (const text of ['이 상품군은 체험 구성품이 안 맞아요. 이번만 빼 주세요.', '당분간 카드 할인은 7%까지만 갑시다.', '오늘 점심 뭐 먹지']) {
  const t1 = Date.now();
  const r = await interpretReason(client, text, sb, DEFAULT_MENU, world.products.map((x) => x.id));
  console.log(`\ninterpret "${text}" -> ${r.ok ? 'ok' : 'rejected ' + r.errors.join('; ')} ${Date.now() - t1}ms`);
  if (r.ok) console.log(' ', JSON.stringify(r.interpretation), '\n ', describeInterpretation(r.interpretation, DEFAULT_MENU));
}
}
main().catch((e) => { console.error(e); process.exit(1); });
