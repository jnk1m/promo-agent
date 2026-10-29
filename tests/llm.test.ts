import { describe, expect, it } from 'vitest';
import { DEFAULT_MENU } from '../src/lib/domain';
import { scriptedClient } from '../src/lib/llm/client';
import { interpretReason } from '../src/lib/llm/interpret';
import { buildSlots, explainProposal, validateSlots } from '../src/lib/llm/explain';
import { proposeFor, recordDecision } from '../src/lib/state';
import { devState, sched } from './helpers';

describe('T9 해석 검증', () => {
  it('없는 사은품 id, 원문에 없는 인용, 원문에 없는 숫자는 활성화되지 않는다', async () => {
    const { world } = devState();
    const sb = sched(world);
    const text = '이 상품군은 체험 구성품이 안 맞아요. 이번만 빼 주세요.';
    const bad1 = { kind: 'ban_gift', scope: { category: sb.category }, target: { giftId: 'Z' }, duration: { type: 'this_broadcast', broadcastId: sb.id }, quote: '체험 구성품이 안 맞아요', confidence: 'high' };
    const bad2 = { kind: 'ban_gift', scope: { category: sb.category }, target: { giftId: 'B' }, duration: { type: 'this_broadcast', broadcastId: sb.id }, quote: '원문에 없는 구절', confidence: 'high' };
    const bad3 = { kind: 'cap_card', scope: { category: sb.category }, target: { maxCardLevel: 7 }, duration: { type: 'this_broadcast', broadcastId: sb.id }, quote: '이번만', confidence: 'high' };
    const r = await interpretReason(scriptedClient([bad1, bad2, bad3]), text, sb, DEFAULT_MENU, world.products.map((p) => p.id), 3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.attempts).toBe(3);
      expect(r.errors.join(' ')).toContain('숫자');
    }
  });
  it('올바른 해석은 통과하고 확인 전에는 후보일 뿐이다', async () => {
    const { world, state } = devState();
    const sb = sched(world);
    const text = '이 상품군은 체험 구성품이 안 맞아요. 이번만 빼 주세요.';
    const good = { kind: 'ban_gift', scope: { category: sb.category }, target: { giftId: 'B' }, duration: { type: 'this_broadcast', broadcastId: sb.id }, quote: '체험 구성품이 안 맞아요', confidence: 'high' };
    const r = await interpretReason(scriptedClient([good]), text, sb, DEFAULT_MENU, world.products.map((p) => p.id));
    expect(r.ok).toBe(true);
    expect(state.ledger.length).toBe(0);
  });
});

describe('T10 슬롯 문장', () => {
  it('슬롯 밖 숫자가 든 문장은 거부되고 템플릿으로 대체된다', async () => {
    const { world, state } = devState();
    const sb = sched(world);
    const p = proposeFor(state, sb);
    const slots = buildSlots(p, DEFAULT_MENU);
    expect(validateSlots('예상 주문은 {{orders_p50}}입니다.', slots)).toEqual([]);
    expect(validateSlots('예상 주문은 250건입니다.', slots).join(' ')).toContain('숫자');
    expect(validateSlots('{{nope}}', slots).join(' ')).toContain('없는 슬롯');
    const bad = { why: '{{chosen_combo}}을 제안합니다. 주문 300건 예상.', alternatives: [], caution: '' };
    const client = scriptedClient([bad, bad]);
    const r = await explainProposal(client, p, DEFAULT_MENU);
    expect(r.source).toBe('template');
    expect(r.rejected.length).toBe(2);
    expect(r.filled.why).toContain(slots.chosen_combo);
    expect(validateSlots(r.explanation.why, slots)).toEqual([]);
  });
  it('모델이 슬롯만 쓰면 채워진 문장이 나온다', async () => {
    const { world, state } = devState();
    const sb = sched(world);
    const p = proposeFor(state, sb);
    const ok = { why: '{{chosen_combo}}을 제안합니다. 가장 나을 확률은 {{pbest}}입니다.', alternatives: ['{{alt1_combo}}은 {{alt1_why}} 때문에 뒤로 뒀습니다.'], caution: '' };
    const r = await explainProposal(scriptedClient([ok]), p, DEFAULT_MENU);
    expect(r.source).toBe('model');
    expect(r.filled.why).toContain('%');
  });
});

describe('R8 결정 기록', () => {
  it('승인과 수정이 구분되어 기록된다', () => {
    const { world, state } = devState();
    const sb = sched(world);
    const p = proposeFor(state, sb);
    const s1 = recordDecision(state, sb, p, p.chosen!.combo, [], undefined, []);
    expect(s1.decisions[0].status).toBe('approved');
    const other = p.alternatives[0].eval.combo;
    const s2 = recordDecision(state, sb, p, other, ['마진 우선'], '사은품이 안 맞음', []);
    expect(s2.decisions[0].status).toBe('modified');
    expect(s2.decisions[0].final.giftId).toBe(other.giftId);
  });
});
