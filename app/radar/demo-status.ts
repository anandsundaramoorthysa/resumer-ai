/**
 * Canned Job Radar run for /radar?demo=1. Pure and client-side: no network, no DB, no key.
 * The status is derived from `phase` alone (stateless), so the run-view hook can treat it
 * like the real API. Everything here is SAMPLE DATA and says so (mode: 'replay').
 */

import type { RadarStatus, RadarEvent } from '@/lib/radar/events';
import type { Posting, RankedPosting, EmployerIntel, MarketSignal } from '@/lib/serp/types';

// Same phase names as lib/radar/runs.ts: plan -> awaiting-queries -> search -> rank -> intel -> select -> done.
const STAGES = ['plan', 'awaiting-queries', 'search', 'rank', 'intel', 'select', 'done'];
const STEP_MS = 1500;

const QUERIES = [
  { q: 'junior full stack developer react node', why: 'Your strongest, most provable stack' },
  { q: 'software engineer typescript postgres bengaluru', why: 'Same skills, nearer your location' },
];

const mk = (key: string, title: string, company: string, location: string, via: string, lo: number, hi: number, src: 'serp' | 'regex' | 'none', hl: string[]): Posting => ({
  key, title, company, location, via, description: '', postedAt: '3 days ago', scheduleType: 'Full-time',
  salaryLpa: { min: lo, max: hi, source: src }, highlights: hl, serpJobId: key, fromQuery: 0,
  applyLinks: [{ title: `Apply on ${via}`, link: `https://example.com/${key}` }],
});

const POSTINGS: Posting[] = [
  mk('d1', 'Full Stack Engineer', 'Lumen Labs', 'Bengaluru, Karnataka', 'LinkedIn', 8, 12, 'regex', ['React', 'Node.js', 'PostgreSQL']),
  mk('d2', 'Software Engineer, Platform', 'Northwind Systems', 'Remote, India', 'Naukri', 10, 14, 'serp', ['TypeScript', 'Docker']),
  mk('d3', 'Frontend Developer', 'Paperkite', 'Chennai, Tamil Nadu', 'Indeed', 6, 9, 'regex', ['React', 'CSS']),
  mk('d4', 'Backend Engineer (Python)', 'Orchard Pay', 'Hyderabad, Telangana', 'Glassdoor', 0, 0, 'none', ['Python', 'AWS']),
];

const RANKED: RankedPosting[] = [
  { key: 'd1', score: 86, coveragePct: 82, matched: ['React', 'Node.js', 'PostgreSQL', 'TypeScript'], missing: ['Kubernetes'], reason: 'Four of five core skills are on your resume.' },
  { key: 'd2', score: 74, coveragePct: 68, matched: ['TypeScript', 'Docker'], missing: ['Terraform', 'AWS'], reason: 'Strong on language, thin on infrastructure.' },
  { key: 'd3', score: 61, coveragePct: 55, matched: ['React', 'CSS'], missing: ['Next.js', 'Jest'], reason: 'Frontend-only; fewer of your backend proofs apply.' },
  { key: 'd4', score: 38, coveragePct: 30, matched: ['AWS'], missing: ['Python', 'Django', 'Redis'], reason: 'Different primary language.' },
];

const INTEL: EmployerIntel[] = [
  { company: 'Lumen Labs', rating: 4.2, ratingSource: 'Glassdoor', reviewsCount: 312, headlines: [{ title: 'Lumen Labs raises Series A to expand engineering', source: 'Sample Times', link: 'https://example.com/news', date: '2 weeks ago' }] },
];

const MARKET: MarketSignal = {
  sampleSize: 4,
  salaryLpa: { p25: 7.5, median: 10, p75: 12.5, n: 3 },
  topSkills: [
    { skill: 'React', pct: 75, held: true },
    { skill: 'TypeScript', pct: 50, held: true },
    { skill: 'Docker', pct: 50, held: true },
    { skill: 'AWS', pct: 50, held: false },
    { skill: 'Kubernetes', pct: 25, held: false },
  ],
  gapSkills: ['AWS', 'Kubernetes', 'Terraform'],
};

const LOG: [string, RadarEvent['level'], string, string?][] = [
  ['plan', 'info', 'Planned 2 searches from your profile', 'groq'],
  ['awaiting-queries', 'info', 'Waiting for you to approve the searches'],
  ['search', 'info', 'Found 5 postings across 2 searches', 'serpapi:google_jobs'],
  ['rank', 'info', 'Ranked 4 postings and summarised pay and skills', 'local'],
  ['intel', 'info', 'Looked up Lumen Labs', 'serpapi:google_maps'],
  ['select', 'info', 'Pick the posting to tailor your resume for'],
  ['done', 'info', 'Done'],
];

export function demoStatus(phase: string, intelOn: boolean, edited?: { q: string; why: string }[]): RadarStatus {
  const i = Math.max(0, STAGES.indexOf(phase));
  // Newest event is stamped "now" so the live elapsed counter starts at 0s for the current step
  // (and does not include time spent waiting at a gate).
  const base = Date.now() - i * STEP_MS;
  const nQ = (edited ?? QUERIES).length;
  const events: RadarEvent[] = LOG.slice(0, i + 1)
    .filter(([p]) => intelOn || !p.startsWith('intel'))
    .map(([p, level, message, source], n) => ({
      at: new Date(base + n * STEP_MS).toISOString(),
      level,
      phase: p,
      message: p === 'search' ? `Found 5 postings across ${nQ} search${nQ === 1 ? '' : 'es'}` : message,
      ...(source ? { source } : {}),
    }));
  const gate = phase === 'awaiting-queries' ? 'queries' : phase === 'select' ? 'select' : '';
  const steps = intelOn ? 6 : 5;
  return {
    runId: 'demo', mode: 'replay', error: '', phase, step: intelOn || i < 5 ? i : i - 1, totalSteps: steps,
    status: gate ? 'awaiting' : phase === 'done' ? 'done' : 'running',
    gate, message: events[events.length - 1]?.message ?? LOG[i][2], events, creditsUsed: i >= 3 ? (intelOn && i >= 5 ? 3 : 2) : 0,
    state: {
      intelOn, gate, plan: i >= 0 ? { queries: QUERIES, location: 'India', seniority: 'entry', rationale: 'Sample plan' } : null,
      queries: i >= 1 ? edited ?? QUERIES : [],
      postings: i >= 3 ? POSTINGS : [], okQueries: i >= 3 ? 2 : 0,
      ranked: i >= 4 ? RANKED : [], intelTargets: [], intel: i >= 5 && intelOn ? INTEL : [],
      market: i >= 4 ? MARKET : null, selectedKey: '', retries: 0,
    },
  };
}

export const demoStart = (intel: boolean) => demoStatus('plan', intel);

/** One advance step; `queries` carried from the approval so edits survive. */
export function demoAdvance(run: RadarStatus): RadarStatus {
  let next = STAGES[Math.min(STAGES.indexOf(run.phase) + 1, STAGES.length - 1)];
  if (next === 'intel' && !run.state.intelOn) next = 'select';
  return demoStatus(next, run.state.intelOn, run.state.queries);
}

export function demoApprove(run: RadarStatus, queries: { q: string; why: string }[]): RadarStatus {
  return demoStatus('search', run.state.intelOn, queries);
}

export function demoSelect(run: RadarStatus, key: string): RadarStatus & { jobText: string } {
  const p = POSTINGS.find((x) => x.key === key) ?? POSTINGS[0];
  const done = demoStatus('done', run.state.intelOn, run.state.queries);
  done.state.selectedKey = p.key;
  return { ...done, jobText: `${p.title} at ${p.company}\n${p.location}\nSample posting (demo). Requires ${p.highlights.join(', ')}.` };
}

export const DEMO_STEP_MS = STEP_MS;
