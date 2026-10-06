/** Market signal — pure aggregate over postings: salary percentiles and in-demand skills. */

import type { MarketSignal, Posting } from '../serp/types';
import { MAX_POSTINGS, SKILL_LEXICON, canonicalSkills, mentionedSkills } from './ranker';

const MIN_SALARY_N = 3;
const WINSOR_N = 10;
const SALARY_BOUNDS = [1, 200] as const; // LPA; outside is a parse error (monthly rupees, USD)

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const v = sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
  return Math.round(v * 10) / 10;
}

export function marketSignal(postings: Posting[], heldKeywords: string[]): MarketSignal {
  const sample = postings.slice(0, MAX_POSTINGS);
  const mids = sample
    .filter((p) => p.salaryLpa.source !== 'none')
    .map((p) => (p.salaryLpa.min + p.salaryLpa.max) / 2)
    .filter((m) => m >= SALARY_BOUNDS[0] && m <= SALARY_BOUNDS[1])
    .sort((a, b) => a - b);
  // Winsorise at p5/p95 only with enough data to know what an outlier is.
  const [lo, hi] = [percentile(mids, 0.05), percentile(mids, 0.95)];
  const clamped = mids.length >= WINSOR_N ? mids.map((m) => Math.min(hi, Math.max(lo, m))) : mids;
  // n < 3 is no data: percentiles stay 0 and the UI must treat n < 3 as "no salary data".
  const enough = clamped.length >= MIN_SALARY_N;

  const counts = new Map<string, number>();
  for (const p of sample) {
    for (const s of mentionedSkills(`${p.title}\n${p.highlights.join('\n')}\n${p.description}`)) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  const held = new Set(heldKeywords.flatMap(canonicalSkills));
  const ranked = SKILL_LEXICON.filter((s) => counts.has(s))
    .sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : 1))
    .map((skill) => ({
      skill,
      pct: Math.round((counts.get(skill)! / sample.length) * 100),
      held: held.has(skill),
    }));

  return {
    sampleSize: sample.length,
    salaryLpa: {
      p25: enough ? percentile(clamped, 0.25) : 0,
      median: enough ? percentile(clamped, 0.5) : 0,
      p75: enough ? percentile(clamped, 0.75) : 0,
      n: clamped.length,
    },
    topSkills: ranked.slice(0, 8),
    gapSkills: ranked.filter((s) => !s.held).slice(0, 5).map((s) => s.skill),
  };
}
