import Link from 'next/link';
import type { EmployerIntel, Posting, RankedPosting } from '@/lib/serp/types';
import { KeywordHighlight } from '@/components/keyword-highlight';
import { ScoreStamp } from '@/components/score-stamp';
import { Chip } from './chip';

const lpa = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const linkChip = 'inline-flex max-w-full border border-rule px-1.5 py-0.5 font-mono text-xs underline underline-offset-2';

export function ResultRow({
  posting,
  rank,
  intel,
  canSelect,
  busy,
  chosen,
  onSelect,
  sample = false,
  signInToTailor = false,
}: {
  posting: Posting;
  rank: RankedPosting;
  intel?: EmployerIntel;
  canSelect: boolean;
  busy: boolean;
  chosen: boolean;
  onSelect: () => void;
  /** Synthetic demo posting: its links go nowhere real, so they are not navigable. */
  sample?: boolean;
  /** Public demo: tailoring needs an account, so link to sign-in instead of selecting. */
  signInToTailor?: boolean;
}) {
  const sal = posting.salaryLpa;
  const news = intel?.headlines[0];
  const apply = posting.applyLinks[0];
  const meta = [posting.company, posting.location, posting.postedAt].filter(Boolean).join(' · ');
  return (
    <li className="rise border-b border-line py-5 first:pt-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-xl leading-snug">{posting.title}</h3>
          <p className="mt-0.5 text-sm text-muted">{meta}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ScoreStamp score={rank.coveragePct / 10} bar={6} size="sm" tilt={false} />
          <span className="font-mono text-xs tabular-nums">match {rank.score}/100</span>
        </div>
      </div>

      <p className="mt-2 text-sm text-muted">{rank.reason}</p>

      {(rank.matched.length > 0 || rank.missing.length > 0) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
          {rank.matched.length > 0 && <span className="eyebrow">You show</span>}
          {rank.matched.map((k) => (
            <KeywordHighlight key={k} text={k} matched={[k]} />
          ))}
          {rank.missing.length > 0 && <span className="eyebrow ml-1">Missing</span>}
          {rank.missing.map((k) => (
            <del key={k} className="text-danger decoration-2">
              {k}
              <span className="sr-only"> (missing)</span>
            </del>
          ))}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {sal.source !== 'none' && (
          <Chip>
            ₹{lpa(sal.min)}–{lpa(sal.max)} LPA{sal.source === 'regex' ? ' · est. from description' : ''}
          </Chip>
        )}
        {intel && intel.rating > 0 && (
          <Chip>
            Rating {intel.rating.toFixed(1)}/5 · {intel.ratingSource}
          </Chip>
        )}
        {news && sample && (
          <span className={`${linkChip} border-dashed text-muted no-underline`}>
            <span className="truncate">Sample news: {news.title}</span>
          </span>
        )}
        {news && !sample && (
          <a href={news.link} target="_blank" rel="noopener noreferrer" className={linkChip}>
            <span className="truncate">News: {news.title}</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        {posting.applyLinks.slice(0, 3).map((l) =>
          sample ? (
            <span key={l.link} className={`${linkChip} border-dashed text-muted no-underline`}>
              Sample posting · {l.title.replace(/^Apply (on|at|via)\s+/i, '')}
            </span>
          ) : (
            <a key={l.link} href={l.link} target="_blank" rel="noopener noreferrer" className={linkChip}>
              Listed on {l.title.replace(/^Apply (on|at|via)\s+/i, '')}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ),
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        {canSelect && signInToTailor && (
          <Link href="/sign-in" className="btn btn-primary">
            Sign in to tailor with your own profile
            <span className="sr-only">
              {' '}
              for {posting.title} at {posting.company}
            </span>
          </Link>
        )}
        {canSelect && !signInToTailor && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onSelect}>
            Tailor my resume
            <span className="sr-only">
              {' '}
              for {posting.title} at {posting.company}
            </span>
          </button>
        )}
        {chosen && !canSelect && <Chip>Selected</Chip>}
        {apply && sample && (
          <span className="btn border-dashed text-muted">Sample posting</span>
        )}
        {apply && !sample && (
          <a href={apply.link} target="_blank" rel="noopener noreferrer" className="btn">
            Apply on {posting.via || apply.title}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>
    </li>
  );
}
