/**
 * Read and edit a stored resume before export — REQ-8.x (editable preview).
 *
 * GET returns the stored document plus, for each line, the profile record it came from
 * so the UI can show provenance. PATCH saves edited text back to the snapshot.
 *
 * An edit deliberately clears that line's sourceRecordId: once you've rewritten it by
 * hand it is your sentence, not a traced-back claim, and the preview should stop
 * implying the system can vouch for it.
 */

import { NextRequest } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { profileRecords, resumeSnapshots } from '@/lib/db/schema';
import type { ResumeDocument } from '@/lib/types';

export const runtime = 'nodejs';

async function loadOwned(userId: string, snapshotId: string) {
  const [row] = await db
    .select()
    .from(resumeSnapshots)
    .where(
      and(eq(resumeSnapshots.id, snapshotId), eq(resumeSnapshots.userId, userId)),
    )
    .limit(1);
  return row ?? null;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ snapshotId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 });

  const { snapshotId } = await ctx.params;
  const row = await loadOwned(userId, snapshotId);
  if (!row) return Response.json({ error: 'Not found.' }, { status: 404 });

  const doc = row.document as unknown as ResumeDocument;

  // Resolve every referenced source record in one query rather than per line.
  const ids = new Set<string>();
  for (const s of doc.sections) {
    for (const i of s.items) if (i.sourceRecordId) ids.add(i.sourceRecordId);
    for (const g of s.groups ?? [])
      for (const i of g.items) if (i.sourceRecordId) ids.add(i.sourceRecordId);
  }

  const sources =
    ids.size > 0
      ? await db
          .select()
          .from(profileRecords)
          .where(
            and(
              eq(profileRecords.userId, userId),
              inArray(profileRecords.id, [...ids]),
            ),
          )
      : [];

  return Response.json({
    id: row.id,
    document: doc,
    score: row.scoreDetail,
    jobRequirement: row.jobRequirement,
    fileName: row.fileName,
    createdAt: row.createdAt,
    sources: Object.fromEntries(
      sources.map((s) => [
        s.id,
        {
          type: s.type,
          origin: s.source,
          text:
            (s.data as Record<string, unknown>).text ??
            (s.data as Record<string, unknown>).name ??
            (s.data as Record<string, unknown>).title ??
            '',
        },
      ]),
    ),
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ snapshotId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 });

  const { snapshotId } = await ctx.params;
  const row = await loadOwned(userId, snapshotId);
  if (!row) return Response.json({ error: 'Not found.' }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    edits?: Array<{
      sectionKey: string;
      groupIndex: number | null;
      itemIndex: number;
      text: string;
    }>;
  } | null;

  if (!body?.edits?.length) {
    return Response.json({ error: 'No edits supplied.' }, { status: 400 });
  }

  const doc = structuredClone(row.document) as unknown as ResumeDocument;

  for (const edit of body.edits) {
    const section = doc.sections.find((s) => s.key === edit.sectionKey);
    if (!section) continue;

    const target =
      edit.groupIndex === null
        ? section.items[edit.itemIndex]
        : section.groups?.[edit.groupIndex]?.items[edit.itemIndex];

    if (!target) continue;
    if (target.text === edit.text) continue;

    target.text = edit.text;
    // Hand-edited text is no longer traceable to a source record.
    target.sourceRecordId = null;
  }

  await db
    .update(resumeSnapshots)
    .set({ document: doc as unknown as Record<string, unknown> })
    .where(eq(resumeSnapshots.id, snapshotId));

  return Response.json({ ok: true, document: doc });
}
