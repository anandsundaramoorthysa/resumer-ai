/**
 * Hybrid retrieval with a cross-domain relevance floor — REQ-4.2, REQ-4.3.
 *
 * Two stages, in this order and for a reason:
 *   1. FLOOR   — exclude records that are off-domain for this role category outright.
 *   2. RANK    — score whatever survived by keyword overlap.
 *
 * Doing the floor first is the whole point. Ranking alone would still let a Kubernetes
 * bullet onto an SEO resume whenever the ranking math happened to like it; excluding it
 * makes that structurally impossible.
 *
 * Ranking is lexical, and only lexical. This module used to carry a second, weighted
 * embedding term — `cosineSimilarity`, a `jobEmbedding` option, a per-record vector — and
 * AUDIT #12 established that nothing ever populated any of it: no caller passed the
 * option, no code wrote the column, and every ranked record scored 0 on that half of the
 * formula, which meant the weights silently collapsed to pure keyword overlap anyway.
 * Code that implies a capability it does not have is worse than not having it, so the
 * branch is gone rather than left looking like a feature. Lexical overlap is also what
 * moves ATS keyword scores, which is the thing this retrieval feeds.
 */

import type { JobRequirement, ProfileRecord } from '../types';
import { profileFor } from './categories';
import { containsPhrase } from '../quality/vocabulary';

export interface RankedRecord {
  record: ProfileRecord;
  score: number;
  keywordScore: number;
  matchedKeywords: string[];
  /** 0..1 — see `domainFit`. Orders records the posting's keywords cannot tell apart. */
  domainFit: number;
}

/** How much on-domain vocabulary a record needs before it's eligible at all. */
export const RELEVANCE_FLOOR = 0.12;

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Does this record's text contain this term? — the shared definition, on word boundaries.
 *
 * Both matchers here tested raw `text.includes(term)`, so "React" matched "reacts to
 * webhook events" and "Go" matched "google". `quality/vocabulary.ts` removed exactly that
 * class of false positive from the scorer and exports `containsPhrase` for the purpose,
 * and until now retrieval did not use it: the stage that decides which records reach the
 * resume was optimising for a looser definition of a match than the gate rewards, so it
 * promoted records on overlap the scorer would never count and left the loop trying to
 * revise its way to a keyword that was never really there.
 */
function hasTerm(text: string, term: string): boolean {
  const t = norm(term);
  return t.length > 0 && containsPhrase(text, t);
}

/** Every searchable string a record contributes. */
export function recordText(r: ProfileRecord): string {
  const parts: string[] = [...r.tags];
  switch (r.type) {
    case 'skill':
      parts.push(r.name, r.category);
      break;
    case 'experience-bullet':
      parts.push(r.text, r.action, r.scale ?? '', r.outcome ?? '');
      break;
    case 'project':
      parts.push(r.name, r.description ?? '', ...r.stack, ...r.impactMetrics);
      break;
    case 'education':
      parts.push(r.institution, r.credential, r.field ?? '');
      break;
    case 'certification':
      parts.push(r.name, r.issuer);
      break;
    case 'achievement':
      parts.push(r.title, r.description);
      break;
    case 'summary':
      parts.push(r.text);
      break;
    case 'publication':
    case 'writing':
      parts.push(r.title, r.venue);
      break;
    case 'award':
      parts.push(r.title, r.issuer ?? '', r.description ?? '');
      break;
    case 'volunteering':
      parts.push(r.role, r.organization, r.description ?? '');
      break;
    case 'language':
      parts.push(r.name, r.proficiency ?? '');
      break;
    case 'interest':
      parts.push(r.name);
      break;
  }
  return norm(parts.join(' '));
}

/**
 * Types the relevance floor may never remove.
 *
 * The floor asks "is this on-domain?", and for these types the question does not apply.
 * A language is not off-domain for an SEO role, it is a language; a degree does not stop
 * being your degree because the posting never says "B.Sc."; a certification and an
 * interest are the same. These are identity, not evidence to be matched against a job —
 * so they are scored and ordered like everything else, but never filtered out. The floor
 * still governs bullets, projects and skills, which is where it does its actual work.
 */
export const FLOOR_EXEMPT_TYPES = new Set<ProfileRecord['type']>([
  'language',
  'education',
  'certification',
  'interest',
  // A summary is identity by the same argument as a degree, and a generic one ("engineer
  // who ships services") carries no domain vocabulary at all — so without this it can be
  // filtered off its own resume, taking the section research calls the most important.
  'summary',
]);

/**
 * REQ-4.2 — domain fit, 0..1. A record with no on-domain vocabulary at all scores 0
 * and gets excluded, regardless of how well it might have ranked.
 */
export function domainFit(record: ProfileRecord, job: JobRequirement): number {
  const cat = profileFor(job.category);
  if (cat.domainVocabulary.length === 0) return 1; // 'general' has no floor

  const text = recordText(record);
  const hits = cat.domainVocabulary.filter((term) => hasTerm(text, term)).length;

  // The job's own keywords count as on-domain too, so a posting asking for something
  // outside the category's stock vocabulary still surfaces the right records.
  const jobHits = job.atsKeywords.filter((k) => hasTerm(text, k)).length;

  const denom = Math.max(4, Math.min(cat.domainVocabulary.length, 12));
  return Math.min(1, (hits + jobHits * 1.5) / denom);
}

function keywordOverlap(
  record: ProfileRecord,
  job: JobRequirement,
): { score: number; matched: string[] } {
  const text = recordText(record);
  const pool = [
    ...job.atsKeywords,
    ...job.requiredSkills,
    ...job.preferredSkills.map((s) => s),
  ];
  if (pool.length === 0) return { score: 0, matched: [] };

  const matched: string[] = [];
  let weighted = 0;
  for (const term of pool) {
    const t = norm(term);
    if (!t) continue;
    if (hasTerm(text, t)) {
      matched.push(term);
      // Required skills count more than "nice to have".
      weighted += job.requiredSkills.some((r) => norm(r) === t) ? 1.5 : 1;
    }
  }
  return { score: Math.min(1, weighted / Math.max(4, pool.length * 0.5)), matched };
}

export interface RankOptions {
  relevanceFloor?: number;
}

/**
 * Below this many surviving records, the floor has stopped filtering and started
 * deleting the resume. Observed live: a keyword set phrased slightly differently by the
 * extractor pushed 173 of 174 records under the floor, and the pipeline cheerfully
 * produced a 270-character document containing one certification.
 */
const MIN_VIABLE_SURVIVORS = 12;

/**
 * Viability is proportional, not absolute.
 *
 * Capping the target at `records.length` looked safe and was not: on a five-record
 * profile it demanded all five survive, so the floor relaxed to zero and filtered
 * nothing at all. A small profile is exactly where a wrong bullet is most visible, so
 * the target is a fraction of the corpus — enough to build from, never so much that
 * filtering becomes impossible.
 */
const VIABLE_FRACTION = 0.4;

function viabilityTarget(corpusSize: number): number {
  if (corpusSize === 0) return 0;
  return Math.max(1, Math.min(MIN_VIABLE_SURVIVORS, Math.ceil(corpusSize * VIABLE_FRACTION)));
}

export function rankRecords(
  records: ProfileRecord[],
  job: JobRequirement,
  options: RankOptions = {},
): { ranked: RankedRecord[]; excluded: ProfileRecord[] } {
  // The floor is a preference, not a guarantee, and it is applied against keywords an
  // LLM phrased — so it must degrade rather than empty the document. Progressively
  // relax until enough records survive to build a resume from; a slightly off-target
  // bullet is recoverable, an empty resume is not.
  const requested = options.relevanceFloor ?? RELEVANCE_FLOOR;

  // Only records the floor can actually filter count toward viability. Exempt types
  // survive every floor by construction, so counting them would let eight languages and
  // four certifications look like a viable resume while every bullet sat below the
  // floor — the relaxation would never fire on exactly the profile that needs it.
  const filterable = (r: ProfileRecord) => !FLOOR_EXEMPT_TYPES.has(r.type);
  const target = viabilityTarget(records.filter(filterable).length);
  const held = countByType(records);

  for (const floor of [requested, requested / 2, requested / 4, 0]) {
    const attempt = rankAtFloor(records, job, floor);
    const viable = attempt.ranked.filter((r) => filterable(r.record)).length;
    if ((viable >= target && keepsEveryCoreType(attempt.ranked, held)) || floor === 0) return attempt;
  }
  return rankAtFloor(records, job, 0);
}

/**
 * The fewest of each core type a floor may leave, when the profile holds any.
 *
 * Counting survivors across all types let a floor pass with every experience bullet
 * removed: on a posting read as five keywords, two skills, six projects and two
 * certifications made "twelve survivors", the floor held, and the resume went out with
 * its roles and no line under any of them. Observed twice, on the owner's own profile
 * ("Selected 0 bullets, 4 projects, 7 skills"). A resume needs some of each; a slightly
 * off-target bullet is recoverable, an Experience section of bare titles is not.
 */
const CORE_MINIMUM: Partial<Record<ProfileRecord['type'], number>> = {
  'experience-bullet': 4,
  skill: 6,
  project: 2,
};

function countByType(records: ProfileRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records) if (!r.flaggedForRemoval) out.set(r.type, (out.get(r.type) ?? 0) + 1);
  return out;
}

/**
 * Whether each core type the profile holds in quantity keeps its minimum.
 *
 * Only in quantity: a profile with one bullet, about something unrelated to the role, may
 * lose it — that is the floor doing its job. A profile with thirteen losing all thirteen is
 * the floor failing, and that is what this refuses.
 */
export function keepsEveryCoreType(ranked: RankedRecord[], held: Map<string, number>): boolean {
  const kept = countByType(ranked.map((r) => r.record));
  for (const [type, minimum] of Object.entries(CORE_MINIMUM)) {
    if ((held.get(type) ?? 0) >= minimum! && (kept.get(type) ?? 0) < minimum!) return false;
  }
  return true;
}

function rankAtFloor(
  records: ProfileRecord[],
  job: JobRequirement,
  floorOverride: number,
): { ranked: RankedRecord[]; excluded: ProfileRecord[] } {
  const floor = floorOverride;
  const ranked: RankedRecord[] = [];
  const excluded: ProfileRecord[] = [];

  for (const record of records) {
    if (record.flaggedForRemoval) {
      excluded.push(record);
      continue;
    }

    // Stage 1 — the floor (REQ-4.2), except on the identity types it cannot judge.
    const fit = domainFit(record, job);
    if (fit < floor && !FLOOR_EXEMPT_TYPES.has(record.type)) {
      excluded.push(record);
      continue;
    }

    // Stage 2 — rank what survived (REQ-4.3).
    const { score: keywordScore, matched } = keywordOverlap(record, job);

    ranked.push({
      record,
      score: keywordScore * (0.7 + 0.3 * fit), // domain fit nudges ordering too
      keywordScore,
      matchedKeywords: matched,
      domainFit: fit,
    });
  }

  // Domain fit breaks ties, because the nudge above multiplies by keyword overlap and so
  // vanishes exactly where it is needed: every record the posting names nothing from
  // scores 0 and kept the order the database returned it in. On the EA analyst posting
  // that was 76 of 95 skills, and the 24-skill cap filled Skills with React, Next.js,
  // Tailwind CSS and Express.js while Machine Learning, Exploratory Data Analysis and Time
  // Series — on a data resume — were left off.
  ranked.sort((a, b) => b.score - a.score || b.domainFit - a.domainFit);
  return { ranked, excluded };
}

/** Caps selections to what fits a resume (REQ-4.3). */
export interface SelectionCaps {
  experienceBullets: number;
  projects: number;
  skills: number;
  achievements: number;
}

export const DEFAULT_CAPS: SelectionCaps = {
  experienceBullets: 14,
  projects: 4,
  skills: 24,
  achievements: 4,
};

export function selectTop(
  ranked: RankedRecord[],
  caps: SelectionCaps = DEFAULT_CAPS,
): ProfileRecord[] {
  const counts = { 'experience-bullet': 0, project: 0, skill: 0, achievement: 0 } as Record<
    string,
    number
  >;
  const limits: Record<string, number> = {
    'experience-bullet': caps.experienceBullets,
    project: caps.projects,
    skill: caps.skills,
    achievement: caps.achievements,
  };

  const out: ProfileRecord[] = [];
  for (const { record } of ranked) {
    const limit = limits[record.type];
    if (limit === undefined) {
      out.push(record); // education/certifications are never trimmed by rank
      continue;
    }
    if (counts[record.type] >= limit) continue;
    counts[record.type] += 1;
    out.push(record);
  }
  return out;
}
