// 시연용 세션을 미리 만든다: 방송 3회(승인, 수정과 이유 해석, 승인)를 대본대로 돌려 src/data/demo-session.json 에 저장.
// 화면의 「시연 상태 불러오기」가 이 파일을 읽는다. 수정 이유는 대본이며, 해석은 만들 때 모델이 한 번 하고 결과를 그대로 얼린다.
// 실행: node --env-file=.env.local --import tsx scripts/make-demo-session.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { CARD_LEVELS, DEFAULT_MENU, type Combo } from '../src/lib/domain';
import { newSession, proposeAt, runAt, type Session } from '../src/lib/engine';
import { applicableConstraints, comboAllowed, newConstraintId, type Constraint } from '../src/lib/ledger/constraints';
import { createEnvClient } from '../src/lib/llm/client';
import { describeInterpretation, interpretReason } from '../src/lib/llm/interpret';
import type { DecisionRecord } from '../src/lib/state';

const same = (a: Combo, b: Combo) => a.cardLevel === b.cardLevel && a.giftId === b.giftId;

function run(session: Session, broadcastId: string, finalCombo: Combo, rec: DecisionRecord): Session {
  const { proposal } = proposeAt(session, broadcastId);
  const pickedEval = proposal.search.evals.find((e) => same(e.combo, finalCombo)) ?? proposal.chosen!;
  const combosToShow = [finalCombo, ...proposal.alternatives.map((a) => a.eval.combo)];
  const s: Session = { ...session, decisions: [...session.decisions.filter((d) => d.broadcastId !== broadcastId), rec] };
  const r = runAt(s, broadcastId, finalCombo, { p10: pickedEval.orders.p10, p90: pickedEval.orders.p90 }, combosToShow);
  const decisions = s.decisions.map((d) => (d.broadcastId === broadcastId ? { ...d, outcome: { orders: r.record.orders, cancelRate: r.record.cancelRate, inInterval: r.inInterval } } : d));
  console.log(`${broadcastId} ${rec.status} ${finalCombo.cardLevel}%/${finalCombo.giftId} 예상 ${Math.round(pickedEval.orders.p10)}~${Math.round(pickedEval.orders.p90)} 실제 ${r.record.orders} ${r.inInterval ? '구간 안' : '구간 밖'}`);
  return { ...s, decisions, outcomes: [...s.outcomes, r.record] };
}

function approve(session: Session, broadcastId: string): Session {
  const { sb, proposal } = proposeAt(session, broadcastId);
  const c = proposal.chosen!;
  const rec: DecisionRecord = { broadcastId, t: sb.t, proposed: c.combo, final: c.combo, status: 'approved', reasonChips: [], constraintIds: [], predictedOrders: c.orders };
  return run(session, broadcastId, c.combo, rec);
}

async function modify(session: Session, broadcastId: string): Promise<Session> {
  const { sb, proposal, world } = proposeAt(session, broadcastId);
  const c = proposal.chosen!;
  // 대본: 고른 조합에 사은품이 있으면 그 사은품을 당분간 금지, 없으면 카드 상한을 한 단계 낮춘다
  let text: string;
  if (c.combo.giftId !== 'none') text = `당분간 ${sb.category}은 사은품 ${c.combo.giftId} 빼 주세요. 지난 방송에서 그 구성 반응이 애매했어요.`;
  else if (c.combo.cardLevel > 0) {
    const lower = CARD_LEVELS.filter((l) => l < c.combo.cardLevel).at(-1)!;
    text = lower === 0 ? '당분간 카드 할인 없이 갑시다. 카드사 정산이 밀려 있어요.' : `당분간 카드 할인은 ${lower}%까지만 갑시다.`;
  } else throw new Error(`대본이 맞지 않는 결정안: ${JSON.stringify(c.combo)}`);
  const client = await createEnvClient();
  const r = await interpretReason(client, text, sb, DEFAULT_MENU, world.products.map((p) => p.id));
  if (!r.ok) throw new Error(`해석 실패: ${r.errors.join('; ')}`);
  const constraint: Constraint = { ...r.interpretation, id: newConstraintId(session.ledger), sourceText: text, status: 'active', createdAtT: sb.t, createdForBroadcastId: sb.id };
  console.log(`${broadcastId} 이유 "${text}" -> ${describeInterpretation(r.interpretation, DEFAULT_MENU)}`);
  const ledger = [...session.ledger, constraint];
  const cs = applicableConstraints(ledger, sb);
  const alt = proposal.search.evals.filter((e) => e.feasible && comboAllowed(e.combo, cs)).sort((a, b) => a.rank - b.rank)[0];
  if (!alt) throw new Error('제약 아래 실행 가능한 대안 없음');
  const rec: DecisionRecord = { broadcastId, t: sb.t, proposed: c.combo, final: alt.combo, status: 'modified', reasonChips: ['지난 방송 반응'], reasonText: text, constraintIds: [constraint.id], predictedOrders: alt.orders };
  return run({ ...session, ledger }, broadcastId, alt.combo, rec);
}

async function main() {
  let s = newSession();
  s = approve(s, 'S0360');
  s = await modify(s, 'S0361');
  s = approve(s, 'S0362');
  const next = proposeAt(s, 'S0363');
  console.log(`S0363 다음 결정안 ${next.proposal.chosen?.combo.cardLevel}%/${next.proposal.chosen?.combo.giftId}, 적용 제약 ${next.proposal.appliedConstraintIds.join(',') || '없음'}`);
  mkdirSync('src/data', { recursive: true });
  writeFileSync('src/data/demo-session.json', JSON.stringify(s, null, 1));
  console.log('saved src/data/demo-session.json');
}
main().catch((e) => { console.error(e); process.exit(1); });
