/**
 * Education identity and normalisation.
 *
 * The same fix roles got, for the same reason. Education records are inserted keyed on
 * a content hash, and extraction runs per file: different files spell one degree
 * differently, each spelling hashes differently, and `onConflictDoNothing()` therefore
 * never fires. One Master's reached the live profile three times:
 *
 *   M.Sc.              | Loyola College (Autonomous), Chennai | start 2024-06
 *   MSc                | Loyola College                       | start 2027
 *   M.Sc. Data Science | Loyola College (Autonomous), Chennai | end   2027
 *
 * Note the dates disagree as well as the strings: "2027" written as a start date is a
 * graduation year mislabelled (AUDIT #6), and `mergeEducation` treats it as one.
 *
 * A fourth row, "Certification in Hindi Proficiency" from "Dakshina Bharat Hindi
 * Prachar Sabha", is not a degree at all — `looksLikeCertification` moves it.
 *
 * The rules here are deliberately narrower than they could be. Each one earns its place
 * against a pair actually observed; anything that would collapse two genuinely different
 * qualifications is called out below rather than applied.
 */

/**
 * Legal-entity suffixes on an institution, which carry no identity. Note what is NOT
 * here: "college", "university", "institute", "school". Stripping the institution-type
 * word would make "Loyola College" and "Loyola University" one school, and they are two.
 */
const INSTITUTION_SUFFIXES =
  /\b(pvt|private|ltd|limited|trust|society|autonomous|deemed|affiliated)\b/g;

/** "(Autonomous)", "(Deemed to be University)" — qualifiers, never the name. */
const INSTITUTION_QUALIFIERS = /\([^)]*\)/g;

/**
 * Words that mean "this is a school", used only to decide whether a comma tail is a
 * campus name or a city. See `stripLocationTail`.
 */
const INSTITUTION_TYPE_WORDS =
  /^(university|college|institute|school|academy|polytechnic|faculty)\b/;

function squash(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Drops a trailing ", Chennai" without dropping a trailing ", Berkeley".
 *
 * Both are a comma followed by a place, so the comma alone cannot decide it. What does
 * decide it is where the institution-type word sits. "Loyola College, Chennai" names
 * itself before the comma and locates itself after it — the tail is disposable. But
 * "University of California, Berkeley" names the *type* first, and everything that
 * distinguishes it from "University of California, Los Angeles" is in the tail, so the
 * tail is kept. That single rule is why those two campuses stay two records.
 */
function stripLocationTail(name: string): string {
  const comma = name.indexOf(',');
  if (comma === -1) return name;
  const head = name.slice(0, comma).trim();
  if (!head) return name;
  return INSTITUTION_TYPE_WORDS.test(head.toLowerCase()) ? name : head;
}

/**
 * "Loyola College (Autonomous), Chennai" and "Loyola College" reduce to one key.
 *
 * Spacing and punctuation are removed entirely, as in `normalizeCompany`: this is an
 * identity key only, and no display string is ever derived from it. "St. Joseph's
 * College" survives as `stjosephscollege`, distinct from `loyolacollege`.
 */
export function normalizeInstitution(institution: string): string {
  const withoutQualifiers = institution.replace(INSTITUTION_QUALIFIERS, ' ');
  const named = stripLocationTail(withoutQualifiers);
  const stripped = squash(named).replace(INSTITUTION_SUFFIXES, ' ');
  return (stripped.trim() || squash(named)).replace(/\s/g, '');
}

/**
 * Degree abbreviations, longest first so "msc" is matched before "ms". Used only to
 * find where the degree stops and the subject starts when the source did not say.
 */
const DEGREE_TOKEN =
  /^(bachelors|bachelor|masters|master|doctorate|mphil|mtech|btech|meng|beng|mba|bba|mca|bca|pgdm|dphil|diploma|msc|bsc|phd|ma|ms|ba|be)/;

/** Squashed to a key: no case, no punctuation, no spacing. Identity only, never shown. */
function key(s: string): string {
  return squash(s).replace(/\s/g, '');
}

/**
 * Splits a credential into the degree and what it was in.
 *
 * "M.Sc. Data Science" and "M.Sc." with `field: "Data Science"` are the same fact told
 * two ways, and both have to reduce to the same pair — degree `msc`, subject
 * `datascience`. Where the record states a `field`, that is the subject and it is peeled
 * off the credential if the credential repeats it. Where it does not, the subject is
 * whatever follows a recognised degree abbreviation, which is how a row carrying only
 * "M.Sc. Data Science" still lines up with one carrying the field separately.
 */
function splitCredential(
  credential: string,
  field?: string,
): { degree: string; subject: string } {
  const whole = key(credential);
  const subject = field ? key(field) : whole.replace(DEGREE_TOKEN, '');
  const degree =
    subject && whole.length > subject.length && whole.endsWith(subject)
      ? whole.slice(0, -subject.length)
      : whole;
  return { degree, subject };
}

/**
 * "M.Sc.", "MSc" and "M.Sc. Data Science" reduce to one key.
 *
 * Punctuation and spacing go, which handles the first two. The third only collapses
 * because the trailing words repeat the subject the record states separately — the
 * degree is what is left. "M.Sc." stays distinct from "B.Sc." and from "M.A." because
 * nothing here touches the letters themselves.
 */
export function normalizeCredential(credential: string, field?: string): string {
  return splitCredential(credential, field).degree;
}

/** The subject, from the `field` where there is one and from the credential otherwise. */
export function normalizeField(credential: string, field?: string): string {
  return splitCredential(credential, field).subject;
}

/**
 * Institution, degree and subject — all three.
 *
 * The subject is in the key deliberately. Reducing "M.Sc. Data Science" to "msc" is what
 * makes the three observed rows one, but on its own it would also make "M.Sc. Physics"
 * and "M.Sc. Data Science" at the same college one degree, and a second Master's is a
 * real thing to hold. Keeping the subject separates them while leaving the duplicates
 * collapsed.
 */
export function educationIdentity(
  institution: string,
  credential: string,
  field?: string,
): string {
  const { degree, subject } = splitCredential(credential, field);
  return `${normalizeInstitution(institution)}::${degree}::${subject}`;
}

export interface EducationLike {
  institution: string;
  credential: string;
  field?: string;
  startDate?: string;
  endDate?: string;
}

/* ------------------------------------------------------------------ dates -- */

interface DatePart {
  raw: string;
  year: number;
  /** null when the source gave a bare year. */
  month: number | null;
}

/** Reads "2024-06", "2027" and "2015-01-01" alike; anything else is not a date. */
function parseDate(value: string | undefined): DatePart | null {
  if (!value) return null;
  const m = /(\d{4})(?:[-/](\d{1,2}))?/.exec(value.trim());
  if (!m) return null;
  const month = m[2] ? Number(m[2]) : null;
  return {
    raw: value.trim(),
    year: Number(m[1]),
    month: month && month >= 1 && month <= 12 ? month : null,
  };
}

/**
 * Earliest of the candidates, preferring precision on a tie.
 *
 * Within one year a bare "2024" is ranked *after* "2024-06" in both directions, so the
 * precise telling is the one that survives a merge either way. It sorts as month 99
 * looking for the earliest and month -1 looking for the latest, which is the same
 * statement made twice.
 */
function pick(dates: DatePart[], want: 'earliest' | 'latest'): DatePart | null {
  if (dates.length === 0) return null;
  const sorted = [...dates].sort((a, b) => {
    if (a.year !== b.year) return want === 'earliest' ? a.year - b.year : b.year - a.year;
    const am = a.month ?? (want === 'earliest' ? 99 : -1);
    const bm = b.month ?? (want === 'earliest' ? 99 : -1);
    return want === 'earliest' ? am - bm : bm - am;
  });
  return sorted[0];
}

function isLater(a: DatePart, b: DatePart): boolean {
  if (a.year !== b.year) return a.year > b.year;
  return (a.month ?? 0) > (b.month ?? 0);
}

/**
 * Picks the better of two tellings of the same qualification.
 *
 * Strings: the longer one wins, because the fuller version is the one carrying the
 * detail — "M.Sc. Data Science" over "MSc", "Loyola College (Autonomous), Chennai" over
 * "Loyola College".
 *
 * Dates: every date either row states is pooled, and the earliest becomes the start and
 * the latest the end. That is what un-mislabels the observed rows — a start of "2027"
 * sitting beside a start of "2024-06" and an end of "2027" is a graduation year in the
 * wrong column, and pooling puts it in the right one. A date is only promoted to the end
 * slot when it is genuinely later than the chosen start, so a single date stated once
 * never quietly becomes a range. Nothing is ever synthesised: every value written here
 * appeared verbatim in one of the two inputs.
 */
export function mergeEducation(a: EducationLike, b: EducationLike): EducationLike {
  const better = (x?: string, y?: string): string =>
    (x?.trim().length ?? 0) >= (y?.trim().length ?? 0) ? (x ?? '') : (y ?? '');

  const starts = [parseDate(a.startDate), parseDate(b.startDate)].filter(
    (d): d is DatePart => d !== null,
  );
  const ends = [parseDate(a.endDate), parseDate(b.endDate)].filter(
    (d): d is DatePart => d !== null,
  );
  const all = [...starts, ...ends];

  const start = starts.length ? pick(all, 'earliest') : null;
  const latest = pick(all, 'latest');
  const end =
    latest && (ends.length > 0 || (start !== null && isLater(latest, start)))
      ? latest
      : null;

  return {
    institution: better(a.institution, b.institution),
    credential: better(a.credential, b.credential),
    field: better(a.field, b.field) || undefined,
    startDate: start?.raw || undefined,
    endDate: end && (!start || end.raw !== start.raw) ? end.raw : undefined,
  };
}

/** Collapses a list to one entry per real qualification. */
export function dedupeEducation(list: EducationLike[]): EducationLike[] {
  const byIdentity = new Map<string, EducationLike>();

  for (const item of list) {
    const identity = educationIdentity(item.institution, item.credential, item.field);
    const existing = byIdentity.get(identity);
    byIdentity.set(identity, existing ? mergeEducation(existing, item) : item);
  }

  return [...byIdentity.values()];
}

/* --------------------------------------------------- misfiled qualifications */

/** "Certification in X", "Certificate of X" — never a degree, whoever issued it. */
const CERTIFICATE_PREFIX = /^(certification|certificate|certified)\b/;

/** A language certificate: "Certification in Hindi Proficiency", "Proficiency in German". */
const PROFICIENCY = /\bproficiency\b/;

/** Only a bare "Diploma in X" — "Post Graduate Diploma" is a real qualification. */
const DIPLOMA_IN = /^diploma\s+in\b/;

/** Words that make an issuer degree-granting, which spares its diplomas. */
const ACADEMIC_ISSUER = /\b(university|college|institute|school|polytechnic|academy)\b/;

export interface ReclassifiedCertification {
  name: string;
  issuer: string;
  issuedDate?: string;
}

/**
 * Spots a certificate filed under Education, and hands back the record it should be.
 *
 * Deliberately timid. A false positive demotes a real degree off the education section,
 * which is far worse than one certificate sitting in the wrong list, so only three
 * shapes qualify: a credential that opens with "Certification"/"Certificate", one that
 * mentions "proficiency", and a bare "Diploma in X" — and the last only when the issuer
 * is not itself a college, because a college diploma is genuine education. Everything
 * with a degree name in it ("M.Sc. Data Science", "B.Sc. Computer Science") falls
 * through untouched.
 *
 * Returns null when the record really is education.
 */
export function looksLikeCertification(
  record: EducationLike,
): ReclassifiedCertification | null {
  const credential = squash(record.credential);
  const issuer = squash(record.institution);

  const isCertificate =
    CERTIFICATE_PREFIX.test(credential) ||
    PROFICIENCY.test(credential) ||
    (DIPLOMA_IN.test(credential) && !ACADEMIC_ISSUER.test(issuer));

  if (!isCertificate) return null;

  return {
    name: record.credential.trim(),
    issuer: record.institution.trim(),
    // Whichever date the source gave, kept rather than discarded. It is outside the
    // certification's identity, so it cannot affect the hash.
    issuedDate: record.endDate?.trim() || record.startDate?.trim() || undefined,
  };
}

/**
 * Splits parsed education into what it really is.
 *
 * Reclassification happens before de-duplication so a certificate never merges into a
 * degree on its way past.
 */
export function partitionEducation(list: EducationLike[]): {
  education: EducationLike[];
  certifications: ReclassifiedCertification[];
} {
  const education: EducationLike[] = [];
  const certifications: ReclassifiedCertification[] = [];

  for (const item of list) {
    const cert = looksLikeCertification(item);
    if (cert) certifications.push(cert);
    else education.push(item);
  }

  return { education: dedupeEducation(education), certifications };
}

/**
 * The content hash input for an education record.
 *
 * The hash is taken over the NORMALISED key rather than the raw strings. Hashing what
 * the source happened to type is precisely what let one degree occupy three rows: the
 * next time the portfolio re-words a credential, a raw hash changes and a fourth row
 * appears, whereas this one does not move.
 */
export function educationHashParts(record: EducationLike): string[] {
  return ['education', educationIdentity(record.institution, record.credential, record.field)];
}
