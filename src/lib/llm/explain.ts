// 결정안 문장. 모델은 슬롯 이름만 쓰고 숫자는 코드가 채운다(R7, T10).
import { z } from 'zod';
import type { Menu } from '../domain';
import type { Proposal } from '../decide/propose';
import type { LlmClient } from './client';

export type Slots = Record<string, string>;

export function buildSlots(p: Proposal, menu: Menu): Slots {
  const c = p.chosen;
  if (!c) return {};
  const gift = (id: string) => menu.gifts.find((g) => g.id === id)?.name ?? id;
  const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const s: Slots = {
    chosen_combo: `카드 청구할인 ${c.combo.cardLevel}% + ${gift(c.combo.giftId)}`,
    orders_p10: `${Math.round(c.orders.p10)}건`,
    orders_p50: `${Math.round(c.orders.p50)}건`,
    orders_p90: `${Math.round(c.orders.p90)}건`,
    revenue_p50: won(c.revenue.p50),
    margin_p10: won(c.margin.p10),
    margin_p50: won(c.margin.p50),
    margin_p90: won(c.margin.p90),
    promo_cost_p50: won(c.promoCost.p50),
    pbest: `${Math.round(c.pBest * 100)}%`,
    feasible: `${p.feasibleCount}개`,
    combo_samples: `${c.sampleCount}건`,
    cell_samples: `${p.cellSamples}건`,
    constraints_n: `${p.appliedConstraintIds.length}개`,
    objective: p.objective === 'margin' ? '마진' : '매출',
  };
  p.alternatives.forEach((a, i) => {
    s[`alt${i + 1}_combo`] = `카드 청구할인 ${a.eval.combo.cardLevel}% + ${gift(a.eval.combo.giftId)}`;
    s[`alt${i + 1}_margin_p50`] = won(a.eval.margin.p50);
    s[`alt${i + 1}_pbest`] = `${Math.round(a.eval.pBest * 100)}%`;
    s[`alt${i + 1}_why`] = a.whyNot.join(', ');
  });
  p.lowConfidence.forEach((l, i) => (s[`low${i + 1}`] = l.detail));
  return s;
}

export const ExplanationSchema = z.object({
  why: z.string(), // 왜 이 조합인지, 2~3문장
  alternatives: z.array(z.string()).max(2), // 버린 대안과 이유, 각 1문장
  caution: z.string(), // 확신 낮은 지점, 1~2문장. 없으면 빈 문자열
});
export type Explanation = z.infer<typeof ExplanationSchema>;

const SLOT_RE = /\{\{([a-z0-9_]+)\}\}/g;

// 슬롯 검증: 슬롯 밖에 숫자가 있으면 거부, 없는 슬롯이면 거부
export function validateSlots(text: string, slots: Slots): string[] {
  const errs: string[] = [];
  const stripped = text.replace(SLOT_RE, (_, name) => {
    if (!(name in slots)) errs.push(`없는 슬롯 {{${name}}}`);
    return '';
  });
  if (/\d/.test(stripped)) errs.push(`슬롯 밖 숫자: "${stripped.match(/[^\s]*\d[^\s]*/)?.[0]}"`);
  if (/[·—]/.test(stripped)) errs.push('가운뎃점 또는 긴 대시');
  return errs;
}

export function fillSlots(text: string, slots: Slots): string {
  return text.replace(SLOT_RE, (_, name) => slots[name] ?? '');
}

export function validateExplanation(e: Explanation, slots: Slots): string[] {
  const errs = [...validateSlots(e.why, slots), ...e.alternatives.flatMap((a) => validateSlots(a, slots)), ...validateSlots(e.caution, slots)];
  if (!e.why.includes('{{chosen_combo}}')) errs.push('why 에 {{chosen_combo}} 없음');
  return errs;
}

// 모델이 실패하면 쓰는 코드 템플릿
export function templateExplanation(p: Proposal): Explanation {
  const why = `{{chosen_combo}}을(를) 제안합니다. {{objective}} 중앙값이 실행 가능한 {{feasible}} 조합 중 가장 높고, 가장 나을 확률은 {{pbest}}입니다. 예상 주문은 {{orders_p10}}에서 {{orders_p90}} 사이이고 중앙값은 {{orders_p50}}입니다.`;
  const alternatives = p.alternatives.map((_, i) => `{{alt${i + 1}_combo}}은(는) {{alt${i + 1}_why}} 때문에 뒤로 뒀습니다.`);
  const caution = p.lowConfidence.length ? p.lowConfidence.map((_, i) => `{{low${i + 1}}}.`).join(' ') : '';
  return { why, alternatives, caution };
}

const SYSTEM = `당신은 홈쇼핑 프로모션 조건 결정 에이전트입니다. 담당자가 읽을 결정안 문장을 씁니다.
절대 규칙:
- 숫자를 직접 쓰지 않습니다. 모든 수치는 주어진 슬롯 이름을 {{slot}} 형태로 넣고 코드가 값을 채웁니다. 숫자가 한 글자라도 있으면 거부됩니다.
- 주어진 슬롯만 씁니다. 없는 슬롯을 만들지 않습니다.
- why 에는 반드시 {{chosen_combo}} 가 들어갑니다.
- 짧게 씁니다. why 는 두세 문장, alternatives 는 각 한 문장, caution 은 한두 문장.
- 습니다체. 가운뎃점(·)과 긴 대시(—)를 쓰지 않습니다. 과장하지 않습니다. 합성 데이터라는 사실을 숨기지 않습니다.
- 「매출을 올린다」처럼 인과를 단정하지 않습니다. 「예상」「추정」으로 씁니다.`;

export type ExplainResult = { explanation: Explanation; filled: { why: string; alternatives: string[]; caution: string }; source: 'model' | 'template'; attempts: number; rejected: string[][] };

export async function explainProposal(client: LlmClient | null, p: Proposal, menu: Menu, maxAttempts = 2): Promise<ExplainResult> {
  const slots = buildSlots(p, menu);
  const rejected: string[][] = [];
  const fill = (e: Explanation) => ({ why: fillSlots(e.why, slots), alternatives: e.alternatives.map((a) => fillSlots(a, slots)), caution: fillSlots(e.caution, slots) });
  if (client && p.chosen) {
    const slotList = Object.entries(slots)
      .map(([k, v]) => `{{${k}}} = ${v}`)
      .join('\n');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const retry = rejected.length ? `\n이전 문장이 거부됐습니다: ${rejected[rejected.length - 1].join('; ')}. 숫자를 슬롯으로 바꿔 다시 쓰세요.` : '';
      const prompt = `쓸 수 있는 슬롯과 값(값은 참고용이고 문장에는 슬롯 이름만 넣습니다):\n${slotList}\n\n목표: ${slots.objective}. 적용된 제약 수: {{constraints_n}}.${retry}`;
      try {
        const e = await client.generateObject({ system: SYSTEM, prompt, schema: ExplanationSchema, maxOutputTokens: 1500, timeoutMs: 20000, purpose: 'explain' });
        const errs = validateExplanation(e, slots);
        if (errs.length === 0) return { explanation: e, filled: fill(e), source: 'model', attempts: attempt, rejected };
        rejected.push(errs);
      } catch (err) {
        rejected.push([err instanceof Error ? err.message : String(err)]);
      }
    }
  }
  const t = templateExplanation(p);
  return { explanation: t, filled: fill(t), source: 'template', attempts: rejected.length, rejected };
}
