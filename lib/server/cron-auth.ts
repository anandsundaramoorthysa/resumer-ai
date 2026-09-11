import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

/** Whether a scheduled-job request carries CRON_SECRET. Shared by every /api/cron route. */
export function cronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header =
    req.headers.get('x-cron-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  // Constant-time, matching the GitHub webhook's comparison. `===` short-circuits on the
  // first differing byte, which is a timing oracle in principle even if extracting a
  // secret through serverless jitter is not realistic in practice.
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
