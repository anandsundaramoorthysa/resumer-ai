import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { resumeSnapshots } from '@/lib/db/schema';
import { Logo } from '@/components/logo';
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
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');

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

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5">
          <Link href="/" className="inline-flex min-h-11 items-center">
            <Logo />
          </Link>
          <Link href="/" className="inline-flex min-h-11 items-center text-muted hover:text-ink text-sm">
            Back to dashboard
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8">
        <ResumeEditor
          snapshotId={row.id}
          initialDocument={row.document as unknown as ResumeDocument}
          score={row.scoreDetail as unknown as QualityGateResult | null}
          fileName={row.fileName}
        />
        {row.jobRequirement ? <ExtrasPanel snapshotId={row.id} /> : null}
      </main>
    </div>
  );
}
