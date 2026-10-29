// 에이전트 상태 한 덩어리. 화면이 JSON 으로 들고 다니고 서버는 순수 함수로 바꾼다.
import { z } from 'zod';
import { BroadcastRecordSchema, MenuSchema, ProductSchema, type BroadcastRecord, type Combo, type Menu, type Product, type ScheduledBroadcast } from './domain';
import { initModel, posterior, predictLog, updateMany, updateOne, type ModelState } from './estimate/model';
import { ConstraintSchema } from './ledger/constraints';
import { propose, type Proposal } from './decide/propose';

export const DecisionRecordSchema = z.object({
  broadcastId: z.string(),
  t: z.number().int(),
  proposed: z.object({ cardLevel: z.number(), giftId: z.string() }),
  final: z.object({ cardLevel: z.number(), giftId: z.string() }),
  status: z.enum(['proposed', 'approved', 'modified']),
  reasonChips: z.array(z.string()),
  reasonText: z.string().optional(),
  constraintIds: z.array(z.string()),
  predictedOrders: z.object({ p10: z.number(), p50: z.number(), p90: z.number() }),
  outcome: z
    .object({
      orders: z.number(),
      cancelRate: z.number(),
      inInterval: z.boolean(),
    })
    .optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const AgentStateSchema = z.object({
  version: z.literal(1),
  model: z.custom<ModelState>((v) => typeof v === 'object' && v !== null && 'P' in (v as object)),
  ledger: z.array(ConstraintSchema),
  decisions: z.array(DecisionRecordSchema),
  products: z.array(ProductSchema),
  menu: MenuSchema,
  history: z.array(BroadcastRecordSchema),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

export function initState(history: BroadcastRecord[], products: Product[], menu: Menu): AgentState {
  const model = updateMany(initModel(), history);
  return { version: 1, model, ledger: [], decisions: [], products, menu, history };
}

export function productOf(state: AgentState, id: string): Product {
  const p = state.products.find((x) => x.id === id);
  if (!p) throw new Error(`unknown product ${id}`);
  return p;
}

export function proposeFor(state: AgentState, sb: ScheduledBroadcast, seed = 1): Proposal {
  return propose(state.model, sb, productOf(state, sb.productId), state.menu, state.ledger, seed);
}

// 갱신 전후 비교(R11). 이번 실적 한 건이 이 칸의 조합별 예측을 얼마나 움직였나.
export type UpdateDiff = {
  before: ModelState;
  after: ModelState;
  record: BroadcastRecord;
  shifts: { combo: Combo; beforeMu: number; afterMu: number; deltaLog: number; deltaPct: number }[];
  inInterval: boolean;
};

export function applyOutcome(state: AgentState, record: BroadcastRecord, combosToShow: Combo[], predicted: { p10: number; p90: number }): { state: AgentState; diff: UpdateDiff } {
  const before = state.model;
  const after = updateOne(before, record);
  const pb = posterior(before);
  const pa = posterior(after);
  const shifts = combosToShow.map((combo) => {
    const x = { category: record.category, daypart: record.daypart, combo };
    const b = predictLog(pb, before, x).mu;
    const a = predictLog(pa, after, x).mu;
    return { combo, beforeMu: b, afterMu: a, deltaLog: a - b, deltaPct: (Math.exp(a - b) - 1) * 100 };
  });
  const inInterval = record.orders >= predicted.p10 && record.orders <= predicted.p90;
  const decisions = state.decisions.map((d) => (d.broadcastId === record.id ? { ...d, outcome: { orders: record.orders, cancelRate: record.cancelRate, inInterval } } : d));
  return {
    state: { ...state, model: after, history: [...state.history, record], decisions },
    diff: { before, after, record, shifts, inInterval },
  };
}
