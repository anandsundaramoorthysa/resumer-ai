/**
 * What "I removed this" means to every writer that could put it back.
 *
 * Removing an entry used to delete the row and nothing else, which lasted exactly until
 * the next sync: the portfolio still said it, the parser proposed it again, and the user
 * was asked to approve a fact they had already thrown away. The same held for a re-imported
 * résumé and for LinkedIn. The row was gone, so nothing in the system knew the answer had
 * ever been given — unlike a proposal denied in the review queue, which leaves a rejected
 * row behind and is refused forever (lib/sync/reconcile.ts).
 *
 * So a removal now leaves its own mark. This module is the rule, kept free of the database
 * so the sync's pure planner and the tests can both use it:
 *
 *   BY FINGERPRINT    the same text, word for word, is the same fact.
 *   BY IDENTITY       "Built the billing service" and "Built the billing service for
 *                     Acme" are one accomplishment written twice; the identity key every
 *                     record type already defines (reconcile's `identityKeyOf`) catches
 *                     the reworded return that the fingerprint alone would miss.
 *
 * Blocking is not deleting: the mark carries a snapshot, and the Removed list on the
 * profile can put the entry back, or lift the block and let the next sync re-propose it.
 */

export interface Dismissal {
  /** The fingerprint of what was removed. */
  contentHash: string;
  /** The looser "same thing, written differently" key, where the type has one. */
  identityKey: string | null;
}

/** What a candidate must present to be checked against the marks. */
export interface DismissalCandidate {
  contentHash: string;
  identityKey?: string | null;
}

/**
 * A test for "has this already been thrown away", built once per sync rather than per
 * record — a portfolio parse checks a few hundred candidates against the whole list.
 *
 * An empty identity key never matches: a record type with no identity is matched on its
 * fingerprint alone, and treating "" as a key would block every other such record.
 */
export function dismissalFilter(dismissals: Dismissal[]): (candidate: DismissalCandidate) => boolean {
  const hashes = new Set(dismissals.map((d) => d.contentHash).filter(Boolean));
  const identities = new Set(
    dismissals.map((d) => d.identityKey).filter((k): k is string => Boolean(k)),
  );
  return (candidate) => {
    if (hashes.has(candidate.contentHash)) return true;
    const key = candidate.identityKey;
    return Boolean(key && identities.has(key));
  };
}

/** Nothing removed — the common case, and worth not building two empty sets for. */
export const ALLOW_EVERYTHING = (): boolean => false;
