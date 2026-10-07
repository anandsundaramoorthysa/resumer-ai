/**
 * India Standard Time (Asia/Kolkata, UTC+05:30, no DST). The one definition of "today" for
 * the per-IST-day caps (radar runs, invite auto-approvals). The AI daily budget is NOT on
 * this clock: it uses the UTC day (lib/ai/daily-budget.ts).
 */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Midnight at the start of the IST day containing `now` (a Date or epoch ms), as an instant. */
export function istDayStart(now: Date | number): Date {
  const t = typeof now === 'number' ? now : now.getTime();
  return new Date(Math.floor((t + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS);
}
