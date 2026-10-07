/**
 * Knowing when a sync read less than the whole repository.
 *
 * "Not in what I parsed" only means "gone from the repository" if everything was parsed.
 * A slice that failed three times, a blob GitHub would not return, a tree it cut short or
 * a rate limit all leave records unread, and treating those as disappearances flagged
 * every approved fact living in the unread part as "No longer found" — and since flagged
 * records are excluded from every generated resume, a transient outage silently emptied
 * sections. Worse, the job then stored the commit SHA, so the next sync said "Already up
 * to date" and nobody ever looked again.
 *
 * The job row has no column for this and the schema is not ours to change, so the marks
 * ride in `partials` (a jsonb array that already carries the step's output) as objects
 * with a `__sync` key, and are stripped before the extractions are merged.
 *
 *   skipped     a slice failed every attempt: this part of the corpus was NOT read
 *   incomplete  the fetch could not read everything (blob failure, truncated tree,
 *               rate limit): the corpus is partial
 *   unread      files were left out on purpose (count and size budgets): the parse is
 *               honest about what it read but cannot vouch for what is missing, so nothing
 *               is flagged — yet the commit is not retried forever, so the SHA is kept
 */

export type PartialKind = 'skipped' | 'incomplete' | 'unread';

export interface PartialMark {
  __sync: { kind: PartialKind; note: string };
}

export const mark = (kind: PartialKind, note: string): PartialMark => ({ __sync: { kind, note } });

function isMark(p: unknown): p is PartialMark {
  return typeof p === 'object' && p !== null && '__sync' in p;
}

export interface SplitPartials<T> {
  extractions: T[];
  skipped: number;
  incomplete: string[];
  unread: string[];
}

export function splitPartials<T>(partials: Array<T | PartialMark>): SplitPartials<T> {
  const out: SplitPartials<T> = { extractions: [], skipped: 0, incomplete: [], unread: [] };
  for (const p of partials) {
    if (!isMark(p)) {
      out.extractions.push(p);
      continue;
    }
    const { kind, note } = p.__sync;
    if (kind === 'skipped') out.skipped += 1;
    else if (kind === 'incomplete') out.incomplete.push(note);
    else out.unread.push(note);
  }
  return out;
}

export interface PassVerdict {
  /** True only when every part was read: the one state in which absence means removal. */
  complete: boolean;
  /** May the commit SHA be stored (so the SHA gate can say "up to date")? */
  storeSha: boolean;
  /** May approved records missing from the parse be flagged? */
  flagMissing: boolean;
  /** What to tell the user, or null for a clean pass. */
  notice: string | null;
}

export function judgePass(s: Pick<SplitPartials<unknown>, 'skipped' | 'incomplete' | 'unread'>): PassVerdict {
  const parts = s.skipped + s.incomplete.length;
  if (parts > 0) {
    const why = s.incomplete.find((n) => /rate limit/i.test(n));
    return {
      complete: false,
      storeSha: false,
      flagMissing: false,
      notice:
        `Partial sync — ${parts} part${parts === 1 ? '' : 's'} skipped, nothing was removed; try again` +
        (why ? ` (${why})` : ''),
    };
  }
  if (s.unread.length > 0) {
    return {
      complete: false,
      storeSha: true,
      flagMissing: false,
      notice: `${s.unread[0]} Nothing was removed.`,
    };
  }
  return { complete: true, storeSha: true, flagMissing: true, notice: null };
}
