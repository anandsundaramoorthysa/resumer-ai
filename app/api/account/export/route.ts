/**
 * Everything this app holds about the signed-in user, as one JSON file.
 *
 * The other half of account deletion: leaving should not mean losing the profile you
 * spent an evening writing. Scoped by the user id on every table, like every other read.
 * The table list is lib/legal/export-tables.ts, which a test keeps complete. Password
 * hashes, OAuth tokens and other people's data are never included.
 */

import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { EXPORT_TABLES } from '@/lib/legal/export-tables';
import { attachmentHeader } from '@/lib/render/filename';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: 'Sign in first.' }, { status: 401 });

  const [account] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      emailVerified: users.emailVerified,
      githubLogin: users.githubLogin,
      portfolioRepo: users.portfolioRepo,
      lastSyncedAt: users.lastSyncedAt,
      approval: users.approval,
      createdAt: users.createdAt,
      hasPassword: sql<boolean>`${users.passwordHash} is not null`, // whether one is set, never the hash
    })
    .from(users)
    .where(eq(users.id, userId));
  const safeAccount = account ?? null;

  const sections = await Promise.all(
    EXPORT_TABLES.map(async (e) => {
      const all = getTableColumns(e.table) as Record<string, PgColumn>;
      const picked = e.columns ? Object.fromEntries(e.columns.map((c) => [c, all[c]])) : all;
      const rows = await db.select(picked).from(e.table).where(eq(all[e.userColumn], userId));
      return [e.key, e.single ? (rows[0] ?? null) : rows] as const;
    }),
  );

  const body = JSON.stringify(
    { exportedAt: new Date().toISOString(), account: safeAccount, ...Object.fromEntries(sections) },
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
