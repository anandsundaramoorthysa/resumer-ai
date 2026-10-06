/**
 * Shared Job Radar schemas. Every field is required (Groq rejects optional schema fields):
 * "absent" is encoded as '', 0 or [].
 */

import { z } from 'zod';

export const PlanSchema = z.object({
  queries: z.array(z.object({ q: z.string(), why: z.string() })).max(3),
  location: z.string(),
  seniority: z.enum(['intern', 'entry', 'mid', 'senior', 'lead', 'unknown']),
  rationale: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PostingSchema = z.object({
  /** sha1(lower(title)|lower(company)) — SerpApi's job_id is unstable and never identity. */
  key: z.string(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  via: z.string(),
  description: z.string(),
  applyLinks: z.array(z.object({ title: z.string(), link: z.string() })),
  postedAt: z.string(),
  scheduleType: z.string(),
  salaryLpa: z.object({
    min: z.number(),
    max: z.number(),
    source: z.enum(['serp', 'regex', 'none']),
  }),
  highlights: z.array(z.string()),
  serpJobId: z.string(),
  fromQuery: z.number(),
});
export type Posting = z.infer<typeof PostingSchema>;

export const RankedPostingSchema = z.object({
  key: z.string(),
  score: z.number(),
  coveragePct: z.number(),
  matched: z.array(z.string()),
  missing: z.array(z.string()),
  reason: z.string(),
});
export type RankedPosting = z.infer<typeof RankedPostingSchema>;

export const EmployerIntelSchema = z.object({
  company: z.string(),
  /** 0 = unknown. */
  rating: z.number(),
  ratingSource: z.string(),
  reviewsCount: z.number(),
  headlines: z.array(
    z.object({ title: z.string(), source: z.string(), link: z.string(), date: z.string() }),
  ),
});
export type EmployerIntel = z.infer<typeof EmployerIntelSchema>;

export const MarketSignalSchema = z.object({
  sampleSize: z.number(),
  salaryLpa: z.object({ p25: z.number(), median: z.number(), p75: z.number(), n: z.number() }),
  topSkills: z.array(z.object({ skill: z.string(), pct: z.number(), held: z.boolean() })),
  gapSkills: z.array(z.string()),
});
export type MarketSignal = z.infer<typeof MarketSignalSchema>;

export type SerpMode = 'live' | 'replay';
export type SerpResult<T> =
  | { ok: true; data: T; cached: boolean; mode: SerpMode; credits: number }
  | { ok: false; reason: 'budget' | 'not-configured' | 'failed' | 'rate'; message: string };
