import { z } from 'zod';
import { DEFAULT_MENU } from '@/lib/domain';
import { proposeAt, SessionSchema, toDto } from '@/lib/engine';
import { explainProposal } from '@/lib/llm/explain';
import { guardedClient, ipOf } from '@/lib/llm/guard';

const Body = z.object({ session: SessionSchema, broadcastId: z.string(), withBefore: z.boolean().optional() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: `잘못된 요청: ${parsed.error.message.slice(0, 200)}` }, { status: 400 });
  const { session, broadcastId, withBefore } = parsed.data;
  try {
    const { sb, proposal, world } = proposeAt(session, broadcastId);
    const product = world.products.find((p) => p.id === sb.productId)!;
    const { client, reason } = await guardedClient(ipOf(req));
    const explanation = await explainProposal(client, proposal, DEFAULT_MENU);
    const before = withBefore && session.outcomes.length > 0 ? toDto(proposeAt(session, broadcastId, session.outcomes.length - 1).proposal) : null;
    return Response.json({ sb, product, proposal: toDto(proposal), explanation, before, llmNote: reason });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
