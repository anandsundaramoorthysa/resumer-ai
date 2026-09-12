'use client';

/**
 * Sharpening one job's bullets from the web — the review surface.
 *
 * Built to the same rule as the import review: everything that came off the web is on
 * screen with the address it came from BEFORE anything is saved, and each line is saved by
 * its own click. There is no "apply all" on purpose — each proposal is a sentence about the
 * user's own work, and a bulk button gets pressed without reading.
 *
 * Two paths, in order of how much they can honestly add:
 *
 *   1. "Find what you've published" — the user's own posts and pages. A page found by a
 *      name search may be someone else's, so it is shown as "found on <domain> — is this
 *      you?" with the passage that matched, and a rewrite drawing on it cannot be added
 *      until the user ticks that box.
 *   2. "Add context about the company" — a page they paste. Facts about the company, never
 *      about them.
 *
 * Refusals are shown rather than hidden: a rewrite the grounding guard rejected names the
 * exact figure no source supports, which is the number the user should add themselves.
 */

import { useState, useTransition } from 'react';
import {
  applyEmployerRewrite,
  findMyEvidenceForRole,
  researchEmployerForRole,
} from './employer-actions';
import type { EmployerContext, RewriteProposal } from '@/lib/profile/employer-context';
import type { SelfEvidence } from '@/lib/profile/self-evidence';

const INPUT =
  'min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-sm outline-none focus:border-brand';
const PRIMARY =
  'min-h-11 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50';
const QUIET =
  'min-h-11 rounded-lg px-3 py-2 text-sm font-semibold text-muted hover:text-ink disabled:opacity-50';

export function EmployerPanel({ roleId, company }: { roleId: string; company: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [evidence, setEvidence] = useState<SelfEvidence | null>(null);
  const [context, setContext] = useState<EmployerContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const findMine = () => {
    setError(null);
    startTransition(async () => {
      const result = await findMyEvidenceForRole(roleId);
      if (result.ok) setEvidence(result.evidence);
      else setError(result.message);
    });
  };

  const readCompany = () => {
    setError(null);
    startTransition(async () => {
      const result = await researchEmployerForRole(roleId, url);
      if (result.ok) setContext(result.context);
      else setError(result.message);
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 min-h-11 rounded-lg px-3 text-xs font-semibold text-brand-dark hover:bg-paper"
      >
        + Find numbers for these lines
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-line bg-paper/60 p-3.5">
      <p className="text-sm font-semibold">Find numbers for your {company} lines</p>
      <p className="mt-1 max-w-prose text-xs text-muted">
        We search for what you have posted about this job yourself — a LinkedIn post, your
        site, a blog — and show every sentence with the page it came from. Nothing is saved
        until you press Add, and nothing from a page you have not confirmed as yours can be.
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={findMine} disabled={pending} className={PRIMARY}>
          {pending ? 'Searching…' : 'Find what I have published'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={QUIET}>
          Close
        </button>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      {evidence ? <Evidence evidence={evidence} /> : null}

      <details className="mt-4 border-t border-line pt-3">
        <summary className="cursor-pointer text-xs font-semibold text-muted">
          Or add context about {company} from its website
        </summary>
        <p className="mt-1.5 max-w-prose text-xs text-muted">
          What a company page says can place your work — what the company does, how big it
          is. It is only ever stated as the company&rsquo;s fact, never as yours.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="acme.com/about"
            aria-label={`${company} website`}
            className={`${INPUT} sm:max-w-sm`}
          />
          <button type="button" onClick={readCompany} disabled={pending} className={QUIET}>
            {pending ? 'Reading…' : 'Read the page'}
          </button>
        </div>
        {context ? <CompanyContext context={context} /> : null}
      </details>
    </div>
  );
}

function Evidence({ evidence }: { evidence: SelfEvidence }) {
  // Which sources the user has confirmed as their own. Local on purpose: a confirmation is
  // a judgement about this search's results, not a fact worth storing.
  const [mine, setMine] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setMine((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="mt-3.5 space-y-3.5">
      <p className="text-xs text-muted">
        Searched for {evidence.query}
        {evidence.note ? ` — ${evidence.note}` : ''}
      </p>

      {evidence.sources.length > 0 ? (
        <ul className="space-y-2.5">
          {evidence.sources.map((s, i) => (
            <li key={s.url} className="rounded-lg border border-line bg-surface p-3">
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={mine.has(i)}
                  onChange={() => toggle(i)}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  Found on{' '}
                  <a href={s.url} target="_blank" rel="noreferrer noopener" className="font-semibold underline">
                    {s.domain}
                  </a>{' '}
                  — confirm this is you
                </span>
              </label>
              <p className="mt-1.5 text-xs italic text-muted">&hellip;{s.tie}&hellip;</p>
              {evidence.facts.filter((f) => f.source === i).length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
                  {evidence.facts
                    .filter((f) => f.source === i)
                    .map((f) => (
                      <li key={f.quote}>&ldquo;{f.quote}&rdquo;</li>
                    ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="space-y-2.5">
        {evidence.proposals.map((p) => {
          const unconfirmed = p.cites.filter((c) => !mine.has(c));
          return (
            <Proposal
              key={p.recordId}
              proposal={p}
              uses={p.cites.map((c) => evidence.sources[c]?.domain).filter(Boolean).join(', ')}
              blocked={
                unconfirmed.length > 0
                  ? `Confirm ${unconfirmed.map((c) => evidence.sources[c]?.domain).join(', ')} is you first.`
                  : null
              }
            />
          );
        })}
      </ul>
    </div>
  );
}

function CompanyContext({ context }: { context: EmployerContext }) {
  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs text-muted">
        {context.source.ok ? `Read from ${context.source.url}` : context.source.message}
      </p>
      {context.facts.length > 0 ? (
        <div>
          <p className="text-xs font-semibold">What that page says about the company — not about you</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted">
            {context.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="space-y-2.5">
        {context.proposals.map((p) => (
          <Proposal key={p.recordId} proposal={p} uses={context.source.ok ? context.source.url : ''} blocked={null} />
        ))}
      </ul>
    </div>
  );
}

function Proposal({
  proposal,
  uses,
  blocked,
}: {
  proposal: RewriteProposal;
  /** Where the new words came from, shown beside the Add button. */
  uses: string;
  /** Why it cannot be added yet, or null. */
  blocked: string | null;
}) {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const add = () => {
    setError(null);
    startTransition(async () => {
      const result = await applyEmployerRewrite(proposal.recordId, proposal.after ?? '');
      if (result.ok) setSaved(true);
      else setError(result.message);
    });
  };

  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <p className="text-xs text-muted">Now: {proposal.before}</p>

      {proposal.after ? (
        <>
          <p className="mt-1.5 text-sm">{proposal.after}</p>
          {uses ? <p className="mt-1 text-xs text-muted">Uses: {uses}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={add}
              disabled={pending || saved || blocked !== null}
              className="min-h-11 rounded-lg bg-brand px-3.5 py-2 text-xs font-semibold text-on-brand hover:bg-brand-dark disabled:opacity-50"
            >
              {saved ? 'Added' : pending ? 'Saving…' : 'Add'}
            </button>
            {blocked && !saved ? <span className="text-xs text-muted">{blocked}</span> : null}
          </div>
        </>
      ) : null}

      {proposal.violations.length > 0 ? (
        <p className="mt-1.5 text-xs text-warning">
          A stronger version was refused: it added{' '}
          {proposal.violations.map((v) => `“${v.token}”`).join(', ')}, which nothing you wrote
          or published states.
        </p>
      ) : null}

      {proposal.question ? (
        <p className="mt-1.5 text-xs">
          <span className="font-semibold">Only you can answer this: </span>
          {proposal.question}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
