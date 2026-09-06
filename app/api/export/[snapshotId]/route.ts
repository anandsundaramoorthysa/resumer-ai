/**
 * Export a stored resume snapshot as PDF or DOCX — REQ-6.3, REQ-6.4.
 *
 * Renders from the frozen snapshot rather than the live profile, so downloading an old
 * application's resume gives you exactly what was sent then, not what your profile says
 * today (REQ-9.2).
 */

import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { resumeSnapshots } from '@/lib/db/schema';
import { renderResumePdf } from '@/lib/render/pdf';
import { renderResumeDocx } from '@/lib/render/docx';
import { resumeFileName } from '@/lib/render/filename';
import type { ResumeDocument } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ snapshotId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return new Response('Unauthorized', { status: 401 });

  const { snapshotId } = await ctx.params;
  const format = req.nextUrl.searchParams.get('format') === 'docx' ? 'docx' : 'pdf';

  const [row] = await db
    .select()
    .from(resumeSnapshots)
    .where(
      // Scoped by userId as well as id — REQ-7.3.
      and(eq(resumeSnapshots.id, snapshotId), eq(resumeSnapshots.userId, userId)),
    )
    .limit(1);

  if (!row) return new Response('Not found', { status: 404 });

  const doc = row.document as unknown as ResumeDocument;
  const buffer =
    format === 'docx' ? await renderResumeDocx(doc) : await renderResumePdf(doc);
  const fileName = resumeFileName(doc, format);

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type':
        format === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
