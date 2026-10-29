import { z } from 'zod';
import { DEFAULT_MENU } from '@/lib/domain';
import { broadcastOf, SessionSchema, worldOf } from '@/lib/engine';
import { describeInterpretation, interpretReason } from '@/lib/llm/interpret';
import { guardedClient, ipOf } from '@/lib/llm/guard';
import { newConstraintId, type Constraint } from '@/lib/ledger/constraints';

const Body = z.object({ session: SessionSchema, broadcastId: z.string(), text: z.string().min(1).max(500) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: `잘못된 요청: ${parsed.error.message.slice(0, 200)}` }, { status: 400 });
  const { session, broadcastId, text } = parsed.data;
  try {
    const world = worldOf(session);
    const sb = broadcastOf(session, broadcastId, world);
    const { client, reason } = await guardedClient(ipOf(req));
    if (!client) return Response.json({ ok: false, errors: [reason ?? '모델 없음'], attempts: 0, llmNote: reason });
    const r = await interpretReason(client, text, sb, DEFAULT_MENU, world.products.map((p) => p.id));
    if (!r.ok) return Response.json({ ok: false, errors: r.errors, attempts: r.attempts, last: r.last ?? null });
    const candidate: Constraint = {
      ...r.interpretation,
      id: newConstraintId(session.ledger),
      sourceText: text,
      status: 'candidate',
      createdAtT: sb.t,
      createdForBroadcastId: sb.id,
    };
    return Response.json({ ok: true, attempts: r.attempts, candidate, description: describeInterpretation(r.interpretation, DEFAULT_MENU) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
