// 콘솔에서 고리 한 바퀴: 결정안 → (승인) → 합성 방송 실행 → 갱신 전후 → 다음 결정안
// 평가 실행기 역할이라 참 함수를 읽어도 된다(합성 실적 생성용).
import { DEFAULT_MENU, allCombos } from '../src/lib/domain';
import { DEV_WORLD, generateHistory, makeSchedule, makeWorld, runBroadcast, trueExpected } from '../src/lib/world/generate';
import { applyOutcome, initState, proposeFor } from '../src/lib/state';

const world = makeWorld(DEV_WORLD);
const history = generateHistory(world);
let state = initState(history, world.products, DEFAULT_MENU);
const schedule = makeSchedule(world, history.length, 3, 7);

const won = (n: number) => `${Math.round(n).toLocaleString()}원`;

for (const sb of schedule) {
  const p = proposeFor(state, sb);
  const c = p.chosen!;
  console.log(`\n■ 방송 ${sb.id} ${sb.category} ${sb.daypart} ${world.products.find((x) => x.id === sb.productId)!.name} (목표 ${sb.objective === 'margin' ? '마진' : '매출'}, 예산 ${won(sb.budget)})`);
  console.log(`  결정안: 카드 ${c.combo.cardLevel}% + 사은품 ${c.combo.giftId}  주문 ${Math.round(c.orders.p10)}~${Math.round(c.orders.p50)}~${Math.round(c.orders.p90)}  마진 ${won(c.margin.p10)}~${won(c.margin.p50)}~${won(c.margin.p90)}  1위확률 ${(c.pBest * 100).toFixed(0)}%  실행가능 ${p.feasibleCount}/${allCombos().length}`);
  for (const a of p.alternatives) console.log(`  대안: 카드 ${a.eval.combo.cardLevel}% + ${a.eval.combo.giftId}  마진중앙 ${won(a.eval.margin.p50)}  (${a.whyNot.join(', ')})`);
  for (const l of p.lowConfidence) console.log(`  확신 낮음: ${l.detail}`);
  // 담당자 승인(스크립트)
  const record = runBroadcast(world, sb, c.combo, sb.t * 31);
  const { state: next, diff } = applyOutcome(state, record, [c.combo, ...p.alternatives.map((a) => a.eval.combo)], { p10: c.orders.p10, p90: c.orders.p90 });
  const te = trueExpected(world, sb, c.combo);
  console.log(`  방송 후: 실제 주문 ${record.orders} (예상 구간 ${diff.inInterval ? '안' : '밖'}, 참 기대 ${Math.round(te)} 는 평가용 표시)`);
  for (const s of diff.shifts) console.log(`  갱신: 카드 ${s.combo.cardLevel}%+${s.combo.giftId} 예측 ${s.deltaPct >= 0 ? '+' : ''}${s.deltaPct.toFixed(1)}%`);
  state = next;
}
console.log(`\n반영한 실적 ${state.model.n}건, 결정 기록 ${state.decisions.length}건`);
