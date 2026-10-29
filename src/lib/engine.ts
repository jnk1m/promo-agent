// 세션 → 상태 재구성. 화면은 세션(시드 + 실적 + 장부 + 결정)만 들고, 서버는 시드에서 같은 상태를 다시 만든다.
import { z } from 'zod';
import { BroadcastRecordSchema, DEFAULT_MENU, type Combo, type ScheduledBroadcast } from './domain';
import { ConstraintSchema } from './ledger/constraints';
import { DEV_WORLD, generateHistory, makeSchedule, makeWorld, runBroadcast, type World } from './world/generate';
import { applyOutcome, DecisionRecordSchema, initState, proposeFor, type AgentState, type UpdateDiff } from './state';
import type { Proposal } from './decide/propose';

export const SessionSchema = z.object({
  seed: z.number().int(),
  scheduleSeed: z.number().int(),
  outcomes: z.array(BroadcastRecordSchema),
  ledger: z.array(ConstraintSchema),
  decisions: z.array(DecisionRecordSchema),
});
export type Session = z.infer<typeof SessionSchema>;

export const SCHEDULE_LENGTH = 12;

export function newSession(seed = DEV_WORLD.seed, scheduleSeed = 7): Session {
  return { seed, scheduleSeed, outcomes: [], ledger: [], decisions: [] };
}

export function worldOf(session: Session): World {
  return makeWorld({ ...DEV_WORLD, seed: session.seed });
}

export function scheduleOf(session: Session, world = worldOf(session)): ScheduledBroadcast[] {
  return makeSchedule(world, world.cfg.historyLength, SCHEDULE_LENGTH, session.scheduleSeed);
}

// 실적을 n건까지만 반영한 상태(기본은 전부)
export function stateOf(session: Session, world = worldOf(session), upTo = session.outcomes.length): AgentState {
  const history = generateHistory(world);
  let state = initState(history, world.products, DEFAULT_MENU);
  state = { ...state, ledger: session.ledger, decisions: session.decisions };
  for (const r of session.outcomes.slice(0, upTo)) {
    const d = session.decisions.find((x) => x.broadcastId === r.id);
    const pred = d ? { p10: d.predictedOrders.p10, p90: d.predictedOrders.p90 } : { p10: 0, p90: Infinity };
    state = applyOutcome(state, r, [], pred).state;
  }
  return state;
}

export function broadcastOf(session: Session, broadcastId: string, world = worldOf(session)): ScheduledBroadcast {
  const sb = scheduleOf(session, world).find((s) => s.id === broadcastId);
  if (!sb) throw new Error(`unknown broadcast ${broadcastId}`);
  return sb;
}

// 직렬화 가능한 결정안(모델 상태 제외)
export type ProposalDto = Omit<Proposal, 'search'> & { evals: Proposal['search']['evals']; releasedConstraintId: string | null };

export function toDto(p: Proposal): ProposalDto {
  const { search, ...rest } = p;
  return { ...rest, evals: search.evals, releasedConstraintId: p.releasedConstraintId };
}

export function proposeAt(session: Session, broadcastId: string, upTo?: number): { sb: ScheduledBroadcast; proposal: Proposal; world: World; state: AgentState } {
  const world = worldOf(session);
  const sb = broadcastOf(session, broadcastId, world);
  const state = stateOf(session, world, upTo);
  return { sb, proposal: proposeFor(state, sb, 1), world, state };
}

export type RunResult = {
  record: ReturnType<typeof runBroadcast>;
  inInterval: boolean;
  shifts: UpdateDiff['shifts'];
};

export function runAt(session: Session, broadcastId: string, finalCombo: Combo, predicted: { p10: number; p90: number }, combosToShow: Combo[]): RunResult {
  const world = worldOf(session);
  const sb = broadcastOf(session, broadcastId, world);
  if (session.outcomes.some((o) => o.id === broadcastId)) throw new Error(`broadcast ${broadcastId} already ran`);
  const record = runBroadcast(world, sb, finalCombo, sb.t * 31 + session.scheduleSeed);
  const state = stateOf(session, world);
  const { diff } = applyOutcome(state, record, combosToShow, predicted);
  return { record, inInterval: diff.inInterval, shifts: diff.shifts };
}
