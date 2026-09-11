/**
 * Everything this app holds about the signed-in user, as one JSON file.
 *
 * The other half of account deletion: leaving should not mean losing the profile you
 * spent an evening writing. Scoped by `userId` on every table, like every other read.
 */

import { eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import {
  applicationFormFields,
  applications,
  auditLog,
  contactInfo,
  draftRuns,
  enrichmentQuestions,
  profileRecords,
  resumeSnapshots,
  roles,
  users,
} from '@/lib/db/schema';
import { attachmentHeader } from '@/lib/render/filename';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 });

  const [account, contact, records, jobs, snapshots, apps, answers, questions, runs, audit] = await Promise.all([
    db.select({ id: users.id, name: users.name, email: users.email, portfolioRepo: users.portfolioRepo }).from(users).where(eq(users.id, userId)),
    db.select().from(contactInfo).where(eq(contactInfo.userId, userId)),
    db.select().from(profileRecords).where(eq(profileRecords.userId, userId)),
    db.select().from(roles).where(eq(roles.userId, userId)),
    // The stored PDFs are re-rendered from the document on demand, so the document is
    // the thing worth exporting; the binaries are not kept.
    db.select({ id: resumeSnapshots.id, createdAt: resumeSnapshots.createdAt, fileName: resumeSnapshots.fileName, jobRequirement: resumeSnapshots.jobRequirement, document: resumeSnapshots.document, scoreDetail: resumeSnapshots.scoreDetail }).from(resumeSnapshots).where(eq(resumeSnapshots.userId, userId)),
    db.select().from(applications).where(eq(applications.userId, userId)),
    db.select().from(applicationFormFields).where(eq(applicationFormFields.userId, userId)),
    db.select().from(enrichmentQuestions).where(eq(enrichmentQuestions.userId, userId)),
    db.select().from(draftRuns).where(eq(draftRuns.userId, userId)),
    db.select().from(auditLog).where(eq(auditLog.userId, userId)),
  ]);

  const body = JSON.stringify(
    { exportedAt: new Date().toISOString(), account: account[0] ?? null, contact: contact[0] ?? null, records, jobs, snapshots, applications: apps, applicationAnswers: answers[0] ?? null, questions, draftRuns: runs, auditLog: audit },
    null,
    1,
  );

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': attachmentHeader(`Resumer_AI_export_${new Date().toISOString().slice(0, 10)}.json`),
      'Cache-Control': 'private, no-store',
    },
  });
}
