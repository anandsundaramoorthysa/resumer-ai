import type { MarketSignal } from '@/lib/serp/types';

const lpa = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(1)}`;

/** Text-labelled bars, no chart library. Every bar has its number printed beside it. */
export function MarketCard({ market }: { market: MarketSignal }) {
  const { salaryLpa: s, topSkills, gapSkills } = market;
  const pcts: [string, number][] = [
    ['25th pct', s.p25],
    ['Median', s.median],
    ['75th pct', s.p75],
  ];
  return (
    <section aria-labelledby="market-h" className="sheet p-5">
      <p className="eyebrow">Market signal · {market.sampleSize} postings</p>
      <h2 id="market-h" className="mt-1 font-display text-2xl">
        What this market pays and asks
      </h2>

      {s.n > 0 ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 border-y border-line py-3">
            {pcts.map(([l, v]) => (
              <div key={l}>
                <dt className="eyebrow">{l}</dt>
                <dd className="mt-1 font-mono text-base font-semibold tabular-nums">{lpa(v)} LPA</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1 text-xs text-muted">From {s.n} postings that state pay. Some are estimated from the description.</p>
        </>
      ) : (
        <p className="mt-4 border-y border-line py-3 text-sm text-muted">Too few postings state a salary to show a range.</p>
      )}

      <h3 className="eyebrow mt-5">Skills asked for</h3>
      <ul className="mt-2 space-y-2">
        {topSkills.map((k) => (
          <li key={k.skill} className="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-0.5 text-sm sm:grid-cols-[8rem_1fr_auto]">
            <span className="truncate">{k.skill}</span>
            <span
              role="img"
              aria-label={`${k.skill}: asked for in ${k.pct}% of postings, ${k.held ? 'on your resume' : 'not on your resume'}`}
              className="progress"
            >
              <span style={{ width: `${k.pct}%`, background: k.held ? 'var(--color-ink)' : undefined }} />
            </span>
            <span className="col-start-2 font-mono text-xs tabular-nums sm:col-start-auto">
              {k.pct}% · {k.held ? 'you have it' : 'you lack it'}
            </span>
          </li>
        ))}
      </ul>

      {gapSkills.length > 0 && (
        <>
          <h3 className="eyebrow mt-5">Skills you lack</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {gapSkills.map((g) => (
              <li key={g} className="border border-dashed border-brand px-2 py-0.5 font-mono text-xs">
                {g}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
