import { connection } from 'next/server';
import { getFlag } from '@/lib/server/flags';
import { formatMaintenance } from './maintenance-text';

/**
 * Owner-set notice from the `maintenance_message` flag. Fail-open: any error renders nothing.
 * connection() opts out of build-time prerendering so a baked-in (stale) message can never ship;
 * the flag read itself is cached 15s per instance in flags.ts. Plain text only.
 */
export async function MaintenanceBanner() {
  let text: string | null = null;
  try {
    await connection();
    text = formatMaintenance(await getFlag('maintenance_message', ''));
  } catch {
    return null;
  }
  if (!text) return null;
  return (
    <div role="status" aria-live="polite" className="border-b border-line bg-brand-tint px-5 py-2 text-center text-sm text-ink">
      {text}
    </div>
  );
}
