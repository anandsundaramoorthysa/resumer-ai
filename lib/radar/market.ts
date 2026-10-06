/** Market signal — pure aggregate over postings: salary percentiles and in-demand skills. */

import type { MarketSignal, Posting } from '../serp/types';
import { keywordMatches, normalizeForMatch } from '../quality/keywords';
import { MAX_POSTINGS, SKILL_LEXICON, mentionedSkills } from './ranker';

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
    .sort((a, b) => a - b);

  const counts = new Map<string, number>();
  for (const p of sample) {
    for (const s of mentionedSkills(`${p.title}\n${p.highlights.join('\n')}\n${p.description}`)) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  const held = normalizeForMatch(heldKeywords.join('\n'));
  const ranked = SKILL_LEXICON.filter((s) => counts.has(s))
    .sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : 1))
    .map((skill) => ({
      skill,
      pct: Math.round((counts.get(skill)! / sample.length) * 100),
      held: keywordMatches(held, skill),
    }));

  return {
    sampleSize: sample.length,
    salaryLpa: {
      p25: percentile(mids, 0.25),
      median: percentile(mids, 0.5),
      p75: percentile(mids, 0.75),
      n: mids.length,
    },
    topSkills: ranked.slice(0, 8),
    gapSkills: ranked.filter((s) => !s.held).slice(0, 5).map((s) => s.skill),
  };
}
