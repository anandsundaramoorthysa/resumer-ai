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
  }
  return norm(parts.join(' '));
}

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

export function rankRecords(
  records: ProfileRecord[],
  job: JobRequirement,
  options: RankOptions = {},
): { ranked: RankedRecord[]; excluded: ProfileRecord[] } {
  const floor = options.relevanceFloor ?? RELEVANCE_FLOOR;
  const ranked: RankedRecord[] = [];
  const excluded: ProfileRecord[] = [];

  for (const record of records) {
    if (record.flaggedForRemoval) {
      excluded.push(record);
      continue;
    }

    // Stage 1 — the floor (REQ-4.2).
    const fit = domainFit(record, job);
    if (fit < floor) {
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
