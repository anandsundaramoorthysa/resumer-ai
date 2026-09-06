/**
 * Review step of the old-resume importer — task 2.3.
 *
 * Merges the per-chunk extractions into the candidate list the confirm UI shows. Pure
 * computation, no AI call — it lives on the server only because the content hashes are
 * built with node:crypto and must match the ones the sync produces.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { buildPreview } from '@/lib/import/parse';
import type { ExtractedProfile } from '@/lib/sync/parse';

export const runtime = 'nodejs';

const BodySchema = z.object({
  partials: z.array(z.record(z.string(), z.unknown())).max(64),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: 'Sign in first.' }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'Expected { partials: object[] }.' }, { status: 400 });
  }

  const preview = buildPreview(parsed.data.partials as unknown as ExtractedProfile[]);
  return Response.json(preview);
}
