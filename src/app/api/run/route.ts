import { z } from 'zod';
import { ComboSchema } from '@/lib/domain';
import { runAt, SessionSchema } from '@/lib/engine';

const Body = z.object({
  session: SessionSchema,
  broadcastId: z.string(),
  finalCombo: ComboSchema,
  predicted: z.object({ p10: z.number(), p90: z.number() }),
  combosToShow: z.array(ComboSchema),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: `잘못된 요청: ${parsed.error.message.slice(0, 200)}` }, { status: 400 });
  const { session, broadcastId, finalCombo, predicted, combosToShow } = parsed.data;
  try {
    return Response.json(runAt(session, broadcastId, finalCombo, predicted, combosToShow));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
