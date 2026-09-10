import 'server-only';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { applications, profileRecords, users } from '@/lib/db/schema';

export interface DashboardData {
  draftCount: number;
  applicationCount: number;
  averageScore: number | null;
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
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  const [recordStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      flagged: sql<number>`count(*) filter (where ${profileRecords.flaggedForRemoval})::int`,
    })
    .from(profileRecords)
    .where(eq(profileRecords.userId, userId));

  /*
   * The three tiles are about the whole history, so they are counted in the database.
   *
   * They used to be derived from the list below, which is capped for the "Recent drafts"
   * table — so "Resumes drafted" could never read higher than the cap however many
   * resumes existed, "Average ATS score" silently averaged only the newest few while
   * being labelled an average, and "Applications tracked" counted only the ones inside
   * that same window. Nothing looked wrong, because a tile showing 8 when the answer is
   * 20 is not obviously a lie, and until drafting worked at all nobody had enough
   * history to notice. Counting where the rows are keeps the cap a fact about the table
   * and not about the numbers.
   *
   * `avg` is cast to float8 rather than left as numeric: postgres.js returns a numeric
   * as a string to avoid precision loss, and `String / 10` would have rendered "6.2" as
   * NaN on the tile.
   */
  const [totals] = await db
    .select({
      drafts: sql<number>`count(*)::int`,
      sent: sql<number>`count(*) filter (where ${applications.status} <> 'draft')::int`,
      averageScore: sql<number | null>`avg(${applications.score})::float8`,
    })
    .from(applications)
    .where(eq(applications.userId, userId));

  // Rows, for the table that lists them. It shows five.
  const apps = await db
    .select()
    .from(applications)
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.createdAt))
    .limit(RECENT_DRAFTS_SHOWN);

  return {
    draftCount: totals?.drafts ?? 0,
    applicationCount: totals?.sent ?? 0,
    averageScore: totals?.averageScore ?? null,
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
