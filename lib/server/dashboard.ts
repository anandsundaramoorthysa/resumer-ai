import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { applications, profileRecords, users } from '@/lib/db/schema';

export interface DashboardData {
  draftCount: number;
  applicationCount: number;
  /** Average score for the newest role only — see getDashboardData. */
  averageScore: number | null;
  /** "Title · Company" of the role that average is for. */
  averageRole: string | null;
  lastSyncedLabel: string;
  portfolioRepo: string | null;
  recordCount: number;
  flaggedCount: number;
  recentDrafts: Array<{
    id: string;
    roleTitle: string;
    company: string;
    category: string;
    score: number | null;
    createdAt: string;
  }>;
}

/** Rows in the "Recent drafts" table. The tiles above it count the whole history. */
const RECENT_DRAFTS_SHOWN = 5;

export async function getDashboardData(userId: string): Promise<DashboardData> {
  /*
   * Five independent reads, issued together (they were five sequential round trips, each
   * paying the full network latency to the database).
   *
   * The counts are lifetime totals, counted in the database — they used to be derived
   * from the capped list, so "Resumes drafted" could never read past the cap.
   *
   * The average is for ONE role: the newest. A lifetime average mixes a data-analyst
   * resume with an SEO one, and the number describes neither. Matched on title and
   * company, case-insensitively; the newest row is found in a subquery so this does not
   * have to wait for the list. Cast to float8 because postgres.js returns a numeric as a
   * string, which would render as NaN on the tile.
   */
  const newest = (col: typeof applications.roleTitle | typeof applications.company) =>
    sql`(select lower(${col}) from ${applications} where ${applications.userId} = ${userId} order by ${applications.createdAt} desc limit 1)`;

  const [[user], [recordStats], [totals], apps, [roleAverage]] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    db
      .select({
        total: sql<number>`count(*)::int`,
        flagged: sql<number>`count(*) filter (where ${profileRecords.flaggedForRemoval})::int`,
      })
      .from(profileRecords)
      .where(eq(profileRecords.userId, userId)),
    db
      .select({
        drafts: sql<number>`count(*)::int`,
        sent: sql<number>`count(*) filter (where ${applications.status} <> 'draft')::int`,
      })
      .from(applications)
      .where(eq(applications.userId, userId)),
    db
      .select()
      .from(applications)
      .where(eq(applications.userId, userId))
      .orderBy(desc(applications.createdAt))
      .limit(RECENT_DRAFTS_SHOWN),
    db
      .select({ avg: sql<number | null>`avg(${applications.score})::float8` })
      .from(applications)
      .where(
        and(
          eq(applications.userId, userId),
          sql`lower(${applications.roleTitle}) = ${newest(applications.roleTitle)}`,
          sql`lower(${applications.company}) = ${newest(applications.company)}`,
        ),
      ),
  ]);
  const latest = apps[0];

  return {
    draftCount: totals?.drafts ?? 0,
    applicationCount: totals?.sent ?? 0,
    averageScore: roleAverage?.avg ?? null,
    averageRole: latest ? [latest.roleTitle, latest.company].filter(Boolean).join(' · ') : null,
    lastSyncedLabel: relativeTime(user?.lastSyncedAt ?? null),
    portfolioRepo: user?.portfolioRepo ?? null,
    recordCount: recordStats?.total ?? 0,
    flaggedCount: recordStats?.flagged ?? 0,
    recentDrafts: apps.map((a) => ({
      id: a.id,
      roleTitle: a.roleTitle,
      company: a.company,
      category: a.category,
      score: a.score,
      createdAt: relativeTime(a.createdAt),
    })),
  };
}

function relativeTime(date: Date | null): string {
  if (!date) return 'Never';
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString();
}
