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

export async function getDashboardData(userId: string): Promise<DashboardData> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  const [recordStats] = await db
    .select({
      total: sql<number>`count(*)::int`,
      flagged: sql<number>`count(*) filter (where ${profileRecords.flaggedForRemoval})::int`,
    })
    .from(profileRecords)
    .where(eq(profileRecords.userId, userId));

  const apps = await db
    .select()
    .from(applications)
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.createdAt))
    .limit(8);

  const scored = apps.filter((a) => typeof a.score === 'number');
  const averageScore =
    scored.length > 0
      ? scored.reduce((sum, a) => sum + (a.score ?? 0), 0) / scored.length
      : null;

  return {
    draftCount: apps.length,
    applicationCount: apps.filter((a) => a.status !== 'draft').length,
    averageScore,
    lastSyncedLabel: relativeTime(user?.lastSyncedAt ?? null),
    portfolioRepo: user?.portfolioRepo ?? null,
    recordCount: recordStats?.total ?? 0,
    flaggedCount: recordStats?.flagged ?? 0,
    recentDrafts: apps.slice(0, 5).map((a) => ({
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
