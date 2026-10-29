// 제약 장부: 담당자 수정 이유에서 나온 제약. 추가 전용, 만료, 해제.
import { z } from 'zod';
import { CARD_LEVELS, CATEGORIES, DAYPARTS, GIFT_IDS, type Combo, type ScheduledBroadcast } from '../domain';

export const ConstraintKind = z.enum(['ban_gift', 'cap_card', 'require_gift', 'note', 'unclear']);

export const ConstraintSchema = z.object({
  id: z.string(),
  kind: ConstraintKind,
  scope: z.object({
    category: z.enum(CATEGORIES).optional(),
    daypart: z.enum(DAYPARTS).optional(),
    productId: z.string().optional(),
  }),
  target: z.object({
    giftId: z.enum(GIFT_IDS).optional(),
    maxCardLevel: z.union([z.literal(0), z.literal(5), z.literal(7), z.literal(10)]).optional(),
  }),
  duration: z.union([z.object({ type: z.literal('this_broadcast'), broadcastId: z.string() }), z.object({ type: z.literal('until_t'), t: z.number().int() }), z.object({ type: z.literal('always') })]),
  quote: z.string(), // 이유 문장에서 그대로 따온 구절
  sourceText: z.string(),
  confidence: z.enum(['high', 'low']),
  status: z.enum(['candidate', 'active', 'released']),
  createdAtT: z.number().int(),
  createdForBroadcastId: z.string(),
});
export type Constraint = z.infer<typeof ConstraintSchema>;

export function scopeMatches(c: Constraint, sb: Pick<ScheduledBroadcast, 'category' | 'daypart' | 'productId'>): boolean {
  if (c.scope.category && c.scope.category !== sb.category) return false;
  if (c.scope.daypart && c.scope.daypart !== sb.daypart) return false;
  if (c.scope.productId && c.scope.productId !== sb.productId) return false;
  return true;
}

export function isLive(c: Constraint, sb: Pick<ScheduledBroadcast, 'id' | 't'>): boolean {
  if (c.status !== 'active') return false;
  const d = c.duration;
  if (d.type === 'this_broadcast') return d.broadcastId === sb.id;
  if (d.type === 'until_t') return sb.t <= d.t;
  return true;
}

export function applicableConstraints(ledger: Constraint[], sb: ScheduledBroadcast): Constraint[] {
  return ledger.filter((c) => (c.kind === 'ban_gift' || c.kind === 'cap_card' || c.kind === 'require_gift') && isLive(c, sb) && scopeMatches(c, sb));
}

export function comboAllowed(combo: Combo, cs: Constraint[]): boolean {
  for (const c of cs) {
    if (c.kind === 'ban_gift' && c.target.giftId && combo.giftId === c.target.giftId) return false;
    if (c.kind === 'cap_card' && c.target.maxCardLevel !== undefined && combo.cardLevel > c.target.maxCardLevel) return false;
    if (c.kind === 'require_gift' && c.target.giftId && combo.giftId !== c.target.giftId) return false;
  }
  return true;
}

// 해석 결과 검증(T9). 실패 이유 목록을 돌려준다. 비면 통과.
export type Interpretation = Omit<Constraint, 'id' | 'status' | 'createdAtT' | 'createdForBroadcastId' | 'sourceText'>;

export function validateInterpretation(it: Interpretation, sourceText: string, sb: ScheduledBroadcast, knownProductIds: string[]): string[] {
  const errs: string[] = [];
  if (it.kind === 'unclear' || it.kind === 'note') return errs;
  if (!it.quote || !sourceText.includes(it.quote)) errs.push('근거 인용이 원문에 없음');
  const nums = it.quote.match(/\d+/g) ?? [];
  for (const n of nums) if (!sourceText.includes(n)) errs.push(`원문에 없는 숫자 ${n}`);
  if (it.kind === 'ban_gift' || it.kind === 'require_gift') {
    if (!it.target.giftId || !GIFT_IDS.includes(it.target.giftId)) errs.push('대상 사은품 id 없음');
    if (it.target.giftId === 'none') errs.push('사은품 없음은 금지나 필수의 대상이 아님');
  }
  if (it.kind === 'cap_card') {
    if (it.target.maxCardLevel === undefined || !(CARD_LEVELS as readonly number[]).includes(it.target.maxCardLevel)) errs.push('카드 상한 단계가 메뉴에 없음');
    const srcNums = (sourceText.match(/\d+/g) ?? []).map(Number);
    if (it.target.maxCardLevel !== undefined && it.target.maxCardLevel !== 0 && !srcNums.includes(it.target.maxCardLevel)) errs.push('상한 숫자가 원문에 없음');
  }
  if (it.scope.category && it.scope.category !== sb.category) errs.push('범위 상품군이 이번 방송과 다름');
  if (it.scope.daypart && it.scope.daypart !== sb.daypart) errs.push('범위 시간대가 이번 방송과 다름');
  if (it.scope.productId && !knownProductIds.includes(it.scope.productId)) errs.push('범위 상품 id 없음');
  if (it.duration.type === 'this_broadcast' && it.duration.broadcastId !== sb.id) errs.push('이번 방송 id 불일치');
  return errs;
}

export function newConstraintId(ledger: Constraint[]): string {
  return `C${String(ledger.length + 1).padStart(3, '0')}`;
}
