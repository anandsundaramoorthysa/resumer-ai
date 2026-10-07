import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { requireApprovedUser } from '@/lib/server/approval';
import { db } from '@/lib/db';
import { resumeSnapshots } from '@/lib/db/schema';
import { AppHeader } from '@/components/app-header';
import { sentApplicationStatus } from '@/lib/server/profile';
import { ResumeEditor } from './resume-editor';
import { ExtrasPanel } from './extras-panel';
import type { QualityGateResult, ResumeDocument } from '@/lib/types';

export const metadata = { title: 'Review resume' };
export const dynamic = 'force-dynamic';

export default async function ResumePage({
  params,
}: {
  params: Promise<{ snapshotId: string }>;
}) {
  const session = await requireApprovedUser();

  const { snapshotId } = await params;
  const [row] = await db
    .select()
    .from(resumeSnapshots)
    .where(
      and(
        eq(resumeSnapshots.id, snapshotId),
        eq(resumeSnapshots.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!row) notFound();
  const sent = await sentApplicationStatus(session.user.id, row.id);

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader width="6xl" session={session} />

      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8 sm:px-5">
        <ResumeEditor
          snapshotId={row.id}
          initialDocument={row.document as unknown as ResumeDocument}
          score={row.scoreDetail as unknown as QualityGateResult | null}
          fileName={row.fileName}
          sent={sent !== null}
        />
        {row.jobRequirement ? <ExtrasPanel snapshotId={row.id} /> : null}
      </main>
    </div>
  );
}
