/**
 * Hybrid retrieval with a cross-domain relevance floor — REQ-4.2, REQ-4.3.
 *
 * Two stages, in this order and for a reason:
 *   1. FLOOR   — exclude records that are off-domain for this role category outright.
 *   2. RANK    — score whatever survived by keyword overlap + (optional) embeddings.
 *
 * Doing the floor first is the whole point. Ranking alone would still let a Kubernetes
 * bullet onto an SEO resume whenever the similarity math happened to like it; excluding
 * it makes that structurally impossible.
 *
 * Embeddings are optional. With none stored, this degrades to pure lexical matching,
 * which is exactly what moves ATS keyword scores anyway — so the app is fully usable
 * before any embedding infrastructure exists.
 */

import type { JobRequirement, ProfileRecord } from '../types';
import { profileFor } from './categories';

export interface RankedRecord {
  record: ProfileRecord;
  score: number;
  keywordScore: number;
  embeddingScore: number;
  matchedKeywords: string[];
}

const KEYWORD_WEIGHT = 0.6;
const EMBEDDING_WEIGHT = 0.4;

/** How much on-domain vocabulary a record needs before it's eligible at all. */
export const RELEVANCE_FLOOR = 0.12;

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
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
      parts.push(r.name, r.description, ...r.stack, ...r.impactMetrics);
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
  const hits = cat.domainVocabulary.filter((term) => text.includes(term)).length;

  // The job's own keywords count as on-domain too, so a posting asking for something
  // outside the category's stock vocabulary still surfaces the right records.
  const jobHits = job.atsKeywords.filter((k) => text.includes(norm(k))).length;

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
    if (text.includes(t)) {
      matched.push(term);
      // Required skills count more than "nice to have".
      weighted += job.requiredSkills.some((r) => norm(r) === t) ? 1.5 : 1;
    }
  }
  return { score: Math.min(1, weighted / Math.max(4, pool.length * 0.5)), matched };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface RankOptions {
  jobEmbedding?: number[] | null;
  /** Per-record embeddings, keyed by record id. */
  embeddings?: Map<string, number[]>;
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

  for (const floor of [requested, requested / 2, requested / 4, 0]) {
    const attempt = rankAtFloor(records, job, options, floor);
    const viable = attempt.ranked.filter((r) => filterable(r.record)).length;
    if (viable >= target || floor === 0) return attempt;
  }
  return rankAtFloor(records, job, options, 0);
}

function rankAtFloor(
  records: ProfileRecord[],
  job: JobRequirement,
  options: RankOptions,
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

    let embeddingScore = 0;
    const emb = options.embeddings?.get(record.id) ?? record_embedding(record);
    if (options.jobEmbedding && emb) {
      embeddingScore = Math.max(0, cosineSimilarity(options.jobEmbedding, emb));
    }

    const hasEmbeddings = Boolean(options.jobEmbedding && emb);
    const combined = hasEmbeddings
      ? keywordScore * KEYWORD_WEIGHT + embeddingScore * EMBEDDING_WEIGHT
      : keywordScore;

    ranked.push({
      record,
      score: combined * (0.7 + 0.3 * fit), // domain fit nudges ordering too
      keywordScore,
      embeddingScore,
      matchedKeywords: matched,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return { ranked, excluded };
}

function record_embedding(r: ProfileRecord): number[] | null {
  return (r as unknown as { embedding?: number[] | null }).embedding ?? null;
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
