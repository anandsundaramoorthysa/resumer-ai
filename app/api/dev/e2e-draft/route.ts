/**
 * Dev-only end-to-end proof.
 *
 * Runs the complete draft pipeline against the signed-in user's real profile and returns
 * the score, the files' sizes, and the text an ATS would actually extract. This exists
 * as a route rather than a script because @react-pdf ships ESM-only export conditions
 * that standalone runners can't resolve — so the Next runtime is the only place the PDF
 * half can honestly be exercised.
 *
 * 404s in production — and, since that guard is a single environment variable, it is no
 * longer the only one. A dev server bound to 0.0.0.0, a tunnel (ngrok, a Codespaces port
 * forward) or a preview build with the wrong NODE_ENV would otherwise have handed an
 * unauthenticated stranger the first user's entire profile and generated resume.
 *
 * So: the signed-in user's own profile when there is a session, and the first user only
 * for a request that arrived directly, with none of the forwarding headers every proxy
 * and tunnel adds. That keeps the terminal harness working over localhost without
 * leaving a hole reachable from anywhere else.
 */

import { NextRequest } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { loadProfileForUser } from '@/lib/server/profile';
import { runDraftPipeline } from '@/lib/pipeline/run';
import { extractTextFromDocx } from '@/lib/render/selftest';
import type { PipelineEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const DEFAULT_JOB = `Technical SEO Lead — Semrush (Remote, India)

We're looking for a senior technical SEO lead to own organic growth for our product
sites. You'll run site audits, fix crawl and indexation issues, own Core Web Vitals work
with the engineering team, and report on organic traffic and rankings monthly.

Requirements: 5+ years in technical SEO, deep experience with Google Analytics 4 and
Search Console, hands-on with Screaming Frog or Sitebulb, comfortable reading HTML/JS,
schema markup, and working with developers on Core Web Vitals.
Nice to have: content strategy experience, basic SQL.`;

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return new Response('Not found', { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { jobInput?: string };

  const session = await auth();
  const userId = session?.user?.id;

  // The unauthenticated fallback is allowed only when the connection itself came from
  // this machine.
  //
  // `Host` is not the test — a client sends whatever it likes there. Neither is
  // `x-forwarded-host`, which Next's own dev server sets even for a direct request. The
  // signal is the RIGHT-most `x-forwarded-for` entry, which is appended by the nearest
  // hop and is therefore the real peer: Next dev writes `::1` for a local request, and
  // any proxy in front of a deployed app writes the actual client address. A remote
  // caller cannot make it loopback by spoofing, because their own value is appended to
  // rather than replaced.
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((v) => v.trim());
  const peer = hops[hops.length - 1] ?? '';
  const local = peer === '' || peer === '::1' || peer === '127.0.0.1' || peer.startsWith('127.');

  if (!userId && !local) {
    return new Response('Not found', { status: 404 });
  }

  const [user] = userId
    ? await db.select().from(users).where(eq(users.id, userId)).limit(1)
    : await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  if (!user) return Response.json({ error: 'No user in the database.' }, { status: 400 });

  const profile = await loadProfileForUser(user.id);
  if (profile.records.length === 0) {
    return Response.json({ error: 'Profile is empty.' }, { status: 400 });
  }

  const events: string[] = [];
  const started = Date.now();

  try {
    const result = await runDraftPipeline(
      {
        userId: user.id,
        contact: profile.contact,
        records: profile.records,
        roles: profile.roles,
        jobInput: body.jobInput ?? DEFAULT_JOB,
      },
      (e: Omit<PipelineEvent, 'at'>) =>
        events.push(`[${e.stage}/${e.status}] ${e.message}`),
    );

    const atsText = await extractTextFromDocx(result.files.docx);

    return Response.json({
      ok: true,
      tookSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
      profile: {
        records: profile.records.length,
        roles: profile.roles.length,
        name: profile.contact.fullName,
      },
      events,
      job: {
        roleTitle: result.job?.roleTitle,
        company: result.job?.company,
        category: result.job?.category,
        keywords: result.job?.atsKeywords,
      },
      score: result.score,
      files: {
        pdf: { name: result.files.pdfName, bytes: result.files.pdf.length },
        docx: { name: result.files.docxName, bytes: result.files.docx.length },
      },
      selfTest: result.selfTest,
      budget: result.budget,
      atsText: atsText.trim(),
    });
  } catch (err) {
    return Response.json(
      {
        ok: false,
        tookSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        events,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
