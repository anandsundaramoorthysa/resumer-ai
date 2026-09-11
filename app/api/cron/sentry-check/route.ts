import { NextResponse, type NextRequest } from 'next/server';
import { cronAuthorized } from '@/lib/server/cron-auth';

// Temporary: proves a server error reaches Sentry from production. Removed after the check.
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (req.nextUrl.searchParams.get('kind') === 'console') {
    console.error('[sentry-check] a logged failure, as the SMTP rejection was');
    return NextResponse.json({ ok: true });
  }
  throw new Error('Sentry check: a server error from production');
}
