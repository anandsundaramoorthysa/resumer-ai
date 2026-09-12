/**
 * Where the line between an AWARD and an ACHIEVEMENT is drawn — once, for everyone.
 *
 * The two types existed side by side with no stated difference, so every writer guessed:
 * the portfolio sync filed a hackathon rank under `achievements`, the LinkedIn import
 * filed the same fact under `award`, and someone typing it by hand produced a third copy.
 * Nothing noticed, because the content hash includes the type — two rows whose titles are
 * identical hash differently the moment one says `award` and the other `achievement`. The
 * cost is visible on the printed resume: lib/generate/assemble.ts builds the Awards
 * section and the Achievements section from separate filters, so the same sentence was
 * printed twice, a few lines apart.
 *
 * The distinction in the words the user sees:
 *
 *   AWARD        someone else conferred it — a prize, a rank, a scholarship.
 *   ACHIEVEMENT  the person did it and nobody handed it to them — shipped, published,
 *                reached a number.
 *
 * Pure and dependency-free: the same rule runs in the profile form, in the parsers, in
 * the steward's rules and in the assembler.
 */

export type HonorType = 'award' | 'achievement';

/** Shown under the title field of the award form, and in the prompts. */
export const AWARD_HINT =
  'Something someone else gave you — a prize, a rank, a scholarship: “1st of 120 teams at the XYZ Hackathon”.';

/** Shown under the title field of the achievement form, and in the prompts. */
export const ACHIEVEMENT_HINT =
  'Something you did that nobody handed you — shipped it, published it, reached a number. A prize belongs under Awards.';

/**
 * One sentence for a model prompt. Sharing it with the on-screen hints is the point: a
 * parser that classifies by a different rule than the form teaches puts the user's own
 * entry and the imported one in two different sections.
 */
export const HONOR_RULE =
  'An AWARD is something someone else conferred: a prize, a rank, a scholarship, a formal honour (it usually has an issuer). An ACHIEVEMENT is something the person did that nobody handed them: shipped, published, organised, reached a number. The same fact is never both.';

/**
 * Wording that names a prize or a rank. Checked against the title and the issuer only —
 * never the description, where "…which later won an award" would retype the person's own
 * work as somebody else's gift.
 */
const CONFERRED =
  /\b(award(ed|s)?|prize|winner|won|runner[-\s]?up|first|second|third|1st|2nd|3rd|place|rank(ed|ing)?|top\s*\d+|medal(l?ist)?|gold|silver|bronze|scholarship|fellowship|honou?r(s|ed|able)?|dean['’]?s?\s+list|champion(ship)?|finalist|trophy|laureate|grant|best\b)/i;

/** Generic honour nouns, dropped before two titles are compared. */
const GENERIC = new Set([
  'award', 'awards', 'awarded', 'prize', 'winner', 'won', 'recipient', 'honor', 'honors',
  'honour', 'honours', 'achievement', 'achievements', 'a', 'an', 'the', 'of', 'for', 'in',
  'at', 'to', 'and', 'by',
]);

/**
 * The key two honours meet under, whatever type they are stored as.
 *
 * Built like `identityKey` in lib/sync/reconcile.ts — normalise, then compare — but it
 * also drops the generic honour nouns, because the duplication this exists to find is
 * usually "Best Innovation Award" filed as an award and "Best Innovation" filed as an
 * achievement. Punctuation and case are discarded for the same reason the education key
 * discards them: two writers never spell one fact the same way twice.
 */
export function honorTitleKey(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !GENERIC.has(w))
    .join(' ')
    .trim();
}

/**
 * The content-hash input for an honour, whichever type it is stored as.
 *
 * Deliberately NOT prefixed with the type. Every other record type puts its own name in
 * front, which is right where the types are genuinely different things — but an award and
 * an achievement with the same title are the SAME fact, and a type-prefixed hash is why
 * the `(userId, contentHash)` unique index let both be written. With one prefix the index
 * itself refuses the second copy, whichever writer arrives second.
 *
 * Rows written before this keep their old hashes; nothing can migrate them, for the reason
 * given in lib/sync/reconcile.ts. They are matched instead by `identityKey`, which now maps
 * both types onto one key, so the next sync moves each across — and the steward's
 * cross-type rule proposes merging any pair that predates all of it.
 */
export function honorHashParts(honor: { title?: unknown }): string[] {
  return ['honor', honorTitleKey(typeof honor.title === 'string' ? honor.title : '')];
}

/**
 * Which of the two a fact is, from its own wording.
 *
 * An issuer settles it on its own: naming who gave it is the definition of conferred.
 * Otherwise the title has to say so. Everything else is an achievement, which is the safe
 * default — calling the person's own work a prize is the claim that is not theirs to make.
 */
export function classifyHonor(honor: {
  title?: unknown;
  issuer?: unknown;
}): HonorType {
  const title = typeof honor.title === 'string' ? honor.title : '';
  const issuer = typeof honor.issuer === 'string' ? honor.issuer.trim() : '';
  if (issuer) return 'award';
  return CONFERRED.test(title) ? 'award' : 'achievement';
}

/**
 * The same fact, re-shaped for the other type. Lossless apart from `issuer`, which an
 * achievement has no field for — and which is precisely the evidence that it was an award.
 */
export function asHonorType(
  type: HonorType,
  honor: { title?: unknown; issuer?: unknown; description?: unknown; date?: unknown },
): Record<string, unknown> {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const out: Record<string, unknown> = { title: str(honor.title) };
  const description = str(honor.description);
  const date = str(honor.date);
  if (description) out.description = description;
  if (date) out.date = date;
  if (type === 'award') {
    const issuer = str(honor.issuer);
    if (issuer) out.issuer = issuer;
  }
  return out;
}
