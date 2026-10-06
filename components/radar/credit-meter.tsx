import type { Credits } from './use-radar';

/** SerpApi credits left and this hour's use. -1 means the server could not tell. */
export function CreditMeter({ credits, used }: { credits: Credits | null; used: number }) {
  if (!credits) return <p className="font-mono text-xs text-muted">Credits: checking…</p>;
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs">
      <div className="flex gap-1.5">
        <dt className="text-muted">Credits left</dt>
        <dd className="font-semibold">{credits.left < 0 ? 'unknown' : credits.left}</dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="text-muted">Used this hour</dt>
        <dd className="font-semibold">{credits.hourUsed}</dd>
      </div>
      <div className="flex gap-1.5">
        <dt className="text-muted">This run</dt>
        <dd className="font-semibold">{used} cr</dd>
      </div>
    </dl>
  );
}
