/**
 * Certification identity and normalisation.
 *
 * The third time this codebase has needed this. Roles hashed on a raw company and title
 * and grew to 16 rows for 10 jobs; education hashed on a raw institution and credential
 * and grew to 3 rows for 1 degree; certifications hash on `['cert', name, issuer]` with
 * no normalisation at all, and the live profile carries the predictable result:
 *
 *   Nanodegree in Agentic AI  | Udacity
 *   Nanodegree, Agentic AI    | Udacity
 *
 * One certificate, written two ways by two passes over the portfolio, hashing two ways
 * and inserting twice. The pattern is the same as the other two modules and so is the
 * fix — normalise the identity, hash the normalised form, merge the fuller telling.
 *
 * What makes this one harder is that certificate names are mostly ordinary English, so
 * an aggressive normaliser merges genuinely different courses. The rules below are
 * therefore narrow: punctuation and connector words go, and nothing else. Every
 * near-miss in the live data was checked against them (see `tests/certifications.test.mts`),
 * and the pairs that must stay apart are named there rather than left to trust.
 */

/**
 * Words that carry no identity in a certificate title.
 *
 * Only true connectives. Not "introduction", not "fundamentals", not "basic" — the live
 * data holds "Introduction to Data Science" and "Introduction to Digital Marketing",
 * "CSS (Basic)" and "Java (Basic)", and dropping the descriptive word would leave those
 * pairs to be told apart by the remainder alone, which is a thinner margin than it looks.
 */
const CONNECTORS = /\b(in|of|the|and|for|to|with|a|an|on|at)\b/g;

function squash(value: string): string {
  return value
    .toLowerCase()
    // An ampersand is the same word as "and", and one source writes each.
    .replace(/&/g, ' and ')
    // Em and en dashes are typography, not content: "Bootstrap 5 — The Complete Guide".
    .replace(/[‐-―]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "Nanodegree in Agentic AI" and "Nanodegree, Agentic AI" reduce alike.
 *
 * The comma and the word "in" are the entire difference between those two, which is why
 * both punctuation and connectives have to go — stripping only one of them leaves the
 * pair distinct and the duplicate in place.
 */
export function normalizeCertName(name: string): string {
  return squash(name).replace(CONNECTORS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The issuer, reduced to the part that identifies it.
 *
 * The parenthetical platform is dropped — "Meta (Coursera)" and "Meta" are one issuer,
 * and "UC San Diego (Coursera)" is San Diego's certificate however it was delivered. The
 * awarding body is what a resume names.
 *
 * Kept deliberately: everything before the parenthesis. "IIT Madras (NPTEL)" and
 * "IIT Kharagpur (NPTEL)" are different institutions and must not collapse onto NPTEL.
 */
export function normalizeIssuer(issuer: string): string {
  const withoutPlatform = issuer.replace(/\([^)]*\)/g, ' ');
  return squash(withoutPlatform).replace(CONNECTORS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A certificate is identified by its name AND its issuer.
 *
 * Never by name alone: "Introduction to Data Science" is offered by half the internet,
 * and two of them are two certificates. `reconcile.ts` keyed on the lower-cased name on
 * its own, which would have merged them.
 */
export function certificationIdentity(name: string, issuer: string): string {
  return `${normalizeCertName(name)}::${normalizeIssuer(issuer)}`;
}

export interface CertificationLike {
  name: string;
  issuer: string;
  issuedDate?: string;
  credentialUrl?: string;
}

/**
 * Picks the better of two tellings of one certificate.
 *
 * The longer name wins, on the same reasoning as roles and education: the fuller string
 * is the one carrying the detail. A date or a credential URL present in either survives,
 * because a missing field is an absence rather than a claim that there is none.
 */
export function mergeCertifications(
  a: CertificationLike,
  b: CertificationLike,
): CertificationLike {
  const longer = (x?: string, y?: string): string =>
    (x?.trim().length ?? 0) >= (y?.trim().length ?? 0) ? (x ?? '') : (y ?? '');

  return {
    name: longer(a.name, b.name),
    issuer: longer(a.issuer, b.issuer),
    issuedDate: a.issuedDate?.trim() || b.issuedDate?.trim() || undefined,
    credentialUrl: a.credentialUrl?.trim() || b.credentialUrl?.trim() || undefined,
  };
}

/** Collapses a list to one entry per real certificate. */
export function dedupeCertifications(list: CertificationLike[]): CertificationLike[] {
  const byIdentity = new Map<string, CertificationLike>();

  for (const cert of list) {
    if (!cert.name?.trim()) continue;
    const key = certificationIdentity(cert.name, cert.issuer ?? '');
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing ? mergeCertifications(existing, cert) : cert);
  }

  return [...byIdentity.values()];
}

/**
 * The content hash input.
 *
 * Over the normalised identity, not the raw strings — hashing what the source happened
 * to type is exactly what produced the duplicate this module exists to prevent, and a
 * raw hash would produce another the next time the wording moved.
 *
 * The 'cert' prefix is kept because it is what every existing row was written with and
 * what `lib/profile/forms.ts` uses for a hand-typed certificate; changing it would make
 * every stored certificate look new.
 */
export function certificationHashParts(record: CertificationLike): string[] {
  return ['cert', certificationIdentity(record.name, record.issuer ?? '')];
}
