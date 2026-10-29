// 담당자의 수정 이유(자유 문장)를 제약 후보로 해석한다. 모델이 해석하고 코드가 검증한다(R9, T9).
import { z } from 'zod';
import { CARD_LEVELS, CATEGORIES, DAYPARTS, GIFT_IDS, type Menu, type ScheduledBroadcast } from '../domain';
import { validateInterpretation, type Interpretation } from '../ledger/constraints';
import type { LlmClient } from './client';

export const InterpretationSchema = z.object({
  kind: z.enum(['ban_gift', 'cap_card', 'require_gift', 'note', 'unclear']),
  scope: z.object({
    category: z.enum(CATEGORIES).optional(),
    daypart: z.enum(DAYPARTS).optional(),
    productId: z.string().optional(),
  }),
  target: z.object({
    giftId: z.enum(GIFT_IDS).optional(),
    maxCardLevel: z.union([z.literal(0), z.literal(5), z.literal(7), z.literal(10)]).optional(),
  }),
  duration: z.union([
    z.object({ type: z.literal('this_broadcast'), broadcastId: z.string() }),
    z.object({ type: z.literal('until_t'), t: z.number().int() }),
    z.object({ type: z.literal('always') }),
  ]),
  quote: z.string(),
  confidence: z.enum(['high', 'low']),
});

export type InterpretResult =
  | { ok: true; interpretation: Interpretation; attempts: number }
  | { ok: false; errors: string[]; attempts: number; last?: Interpretation };

const SYSTEM = `당신은 홈쇼핑 프로모션 조건 결정 에이전트의 해석기입니다. 담당자가 결정안을 고치며 남긴 이유 문장을 구조화된 제약 후보 하나로 바꿉니다.
규칙:
- kind: ban_gift(특정 사은품 금지), cap_card(카드 청구할인 상한), require_gift(특정 사은품 필수), note(제약이 아닌 참고 메모, 약한 표현 포함), unclear(해석 불가, 무관, 모순).
- 문장에 없는 것을 만들지 않습니다. 사은품은 메뉴의 id 로만, 카드 상한은 메뉴의 단계(0, 5, 7, 10)로만 씁니다. 숫자는 문장에 있는 것만 씁니다.
- scope: 문장이 이번 상품만 말하면 productId, 상품군 전체면 category, 시간대를 말하면 daypart. 말하지 않은 범위는 비웁니다. 기본은 이번 방송의 상품군(category)입니다.
- duration: 기본은 this_broadcast(이번 방송만). 「당분간」은 until_t(이번 t + 30). 「앞으로 쭉」「항상」「계속」은 always. 넓히는 말이 없으면 넓히지 않습니다.
- quote: 판단 근거가 된 구절을 문장에서 글자 그대로 복사합니다.
- 약한 표현(되도록, 가능하면, 웬만하면)은 제약이 아니라 note 입니다.
- confidence: 문장이 분명하면 high, 아니면 low.`;

export async function interpretReason(client: LlmClient, text: string, sb: ScheduledBroadcast, menu: Menu, knownProductIds: string[], maxAttempts = 2): Promise<InterpretResult> {
  const gifts = menu.gifts.map((g) => `${g.id}: ${g.name}`).join(', ');
  let errors: string[] = [];
  let last: Interpretation | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retry = errors.length ? `\n이전 해석이 거부됐습니다: ${errors.join('; ')}. 고쳐서 다시 내세요.` : '';
    const prompt = `이번 방송: id=${sb.id}, t=${sb.t}, 상품군=${sb.category}, 시간대=${sb.daypart}, 상품 id=${sb.productId}
사은품 메뉴: ${gifts}
카드 청구할인 단계: ${CARD_LEVELS.join(', ')}
담당자 이유 문장: """${text}"""${retry}`;
    let out: Interpretation;
    try {
      out = await client.generateObject({ system: SYSTEM, prompt, schema: InterpretationSchema, maxOutputTokens: 400, timeoutMs: 20000, purpose: 'interpret' });
    } catch (e) {
      errors = [e instanceof Error ? e.message : String(e)];
      continue;
    }
    last = out;
    errors = validateInterpretation(out, text, sb, knownProductIds);
    if (errors.length === 0) return { ok: true, interpretation: out, attempts: attempt };
  }
  return { ok: false, errors, attempts: maxAttempts, last };
}

// 해석 결과를 사람이 읽는 확인 문장으로(코드 템플릿)
export function describeInterpretation(it: Interpretation, menu: Menu): string {
  const scope = [it.scope.productId ? `상품 ${it.scope.productId}` : null, it.scope.category ? `${it.scope.category} 상품군` : null, it.scope.daypart ? `${it.scope.daypart} 시간대` : null].filter(Boolean).join(', ') || '범위 지정 없음';
  const dur = it.duration.type === 'this_broadcast' ? '이번 방송만' : it.duration.type === 'until_t' ? `t=${it.duration.t} 까지` : '앞으로 계속';
  const giftName = (id?: string) => menu.gifts.find((g) => g.id === id)?.name ?? id ?? '?';
  switch (it.kind) {
    case 'ban_gift':
      return `${scope}에서 ${giftName(it.target.giftId)} 사용 금지, ${dur}.`;
    case 'cap_card':
      return `${scope}에서 카드 청구할인 최대 ${it.target.maxCardLevel}%, ${dur}.`;
    case 'require_gift':
      return `${scope}에서 ${giftName(it.target.giftId)} 반드시 포함, ${dur}.`;
    case 'note':
      return `참고 메모로만 저장합니다(제약 아님): "${it.quote}"`;
    default:
      return '해석하지 못했습니다. 제약을 만들지 않습니다.';
  }
}
