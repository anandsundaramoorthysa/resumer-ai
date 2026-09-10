/**
 * The facts a fit verdict has to respect — computed, not asked for.
 *
 * The fit agent (./agent.ts) writes the verdict, but a model asked "is this candidate a
 * fit?" will happily say yes to anyone. So everything here that CAN be decided without a
 * model is decided here, and handed to the agent as fact and to the grounding step as the
 * standard its answer is checked against:
 *
 *   - which of the posting's terms the WHOLE profile shows, by the gate's own matcher —
 *     not just the resume, which is a selection. This is the ceiling on keyword coverage:
 *     no draft from this profile can match a term the profile does not hold;
 *   - how much work history the roles add up to, overlaps merged;
 *   - what education there is, and whether each is completed or still in progress;
 *   - and a compact digest of the profile in which every item carries a short ref ("P3",
 *     "W1"), so that when the agent says "you have this" it has to say where — and a claim
 *     that cites nothing, or cites a ref that does not exist, can be refused.
 */

import type {
  ContactInfo,
  JobRequirement,
  ProfileRecord,
  RoleRecord,
} from '../types';
import { recordText } from '../retrieval/rank';
import { keywordMatches, normalizeForMatch } from '../quality/keywords';

export interface SkillFact {
  keyword: string;
  held: boolean;
  /** Where the profile shows it — the first, strongest place found. */
  evidence: { ref: string; label: string } | null;
}

export interface EducationFact {
  ref: string;
  credential: string;
  field?: string;
  institution: string;
  endDate?: string;
  status: 'completed' | 'in-progress' | 'unknown';
}

export interface FitFacts {
  roleTitle: string;
  company?: string;
  seniority: JobRequirement['seniority'];
  category: JobRequirement['category'];
  skills: SkillFact[];
  /** Share of the posting's terms the profile holds — 1 when it names none. */
  skillsCoveragePct: number;
  yearsRequired: number | null;
  yearsHeld: number;
  education: EducationFact[];
  location: string | null;
  /** The profile as the agent reads it, every item tagged with its ref. */
  digest: string;
  /** ref -> what it points at. Anything the agent cites must be a key here. */
  refs: Record<string, { label: string; kind: string }>;
}

/*
 * How much of the profile the agent reads in detail — sized by measurement, not taste.
 *
 * The first digest printed every record in full: 10,031 characters for a 170-record
 * profile. Timed against the real EA job description with no deadline, the fit call took
 * 18.5–20.6s at that size, 12.0–13.1s at 6,000 and 10.6–10.8s at 4,000 — and the
 * verdict was the same 42/100 at every size. In production the call has well under 20
 * seconds, and at full size it timed out and fell back to the rules-only report.
 *
 * So everything is still NAMED — every record keeps a ref the agent can cite, because the
 * point of the fit check is to compare the whole profile — but the detail goes where the
 * posting points: the projects, bullets and honours that share the most terms with the
 * job are described, and the rest are listed by name.
 */
const MAX_DIGEST_CHARS = 7_000;
const DETAILED_PROJECTS = 8;
const PROJECT_DESC_CHARS = 90;
const MAX_BULLETS = 12;
const BULLET_CHARS = 110;
const MAX_HONOURS = 8;
const HONOUR_DESC_CHARS = 60;
const SUMMARY_CHARS = 250;

/** Where a term is looked for first — a named skill is stronger evidence than a mention. */
const EVIDENCE_ORDER: Record<string, number> = {
  skill: 0,
  project: 1,
  'experience-bullet': 2,
  certification: 3,
  education: 4,
  role: 5,
  achievement: 6,
  award: 6,
  publication: 7,
  writing: 7,
  summary: 8,
};

export function gatherFitFacts(input: {
  job: JobRequirement;
  records: ProfileRecord[];
  roles: RoleRecord[];
  contact: ContactInfo;
  now?: Date;
}): FitFacts {
  const { job, records, roles, contact } = input;
  const now = input.now ?? new Date();

  const { digest, refs, refOf } = buildDigest(records, roles, contact, job, now);

  // Every searchable thing in the profile, normalised once, in evidence order.
  const sources = [
    ...records.map((r) => ({
      kind: r.type as string,
      ref: refOf.get(r.id) ?? null,
      text: normalizeForMatch(recordText(r)),
    })),
    ...roles.map((r) => ({
      kind: 'role',
      ref: refOf.get(r.id) ?? null,
      text: normalizeForMatch(`${r.title} ${r.company}`),
    })),
  ].sort((a, b) => (EVIDENCE_ORDER[a.kind] ?? 9) - (EVIDENCE_ORDER[b.kind] ?? 9));

  const asked = job.atsKeywords.filter((k) => !isRoleTitleTerm(k, job.roleTitle));
  const skills: SkillFact[] = asked.map((keyword) => {
    const hit = sources.find((s) => s.ref && keywordMatches(s.text, keyword));
    return {
      keyword,
      held: Boolean(hit),
      evidence: hit?.ref ? { ref: hit.ref, label: refs[hit.ref]?.label ?? hit.ref } : null,
    };
  });

  const held = skills.filter((s) => s.held).length;

  const education: EducationFact[] = records
    .filter((r): r is Extract<ProfileRecord, { type: 'education' }> => r.type === 'education')
    .map((e) => ({
      ref: refOf.get(e.id) ?? '',
      credential: e.credential,
      field: e.field,
      institution: e.institution,
      endDate: e.endDate,
      status: educationStatus(e.endDate, now),
    }));

  return {
    roleTitle: job.roleTitle,
    company: job.company,
    seniority: job.seniority,
    category: job.category,
    skills,
    skillsCoveragePct: skills.length === 0 ? 1 : held / skills.length,
    yearsRequired:
      typeof job.yearsOfExperienceRequired === 'number' && job.yearsOfExperienceRequired > 0
        ? job.yearsOfExperienceRequired
        : null,
    yearsHeld: yearsOfWork(roles, now),
    education,
    location: contact.location?.trim() || null,
    digest,
    refs,
  };
}

/**
 * Whether a posting term is the job's own title rather than something to hold.
 *
 * "Product Analyst Intern" is what the posting is called, and nobody's profile contains
 * it — counting it as a missing skill would tell every applicant they lack the job they
 * are applying for. Only multi-word terms are tested: a title like "Python Developer" must
 * not quietly remove "Python", which is a genuine requirement.
 */
export function isRoleTitleTerm(keyword: string, roleTitle: string): boolean {
  const k = normalizeForMatch(keyword);
  const title = normalizeForMatch(roleTitle);
  if (!k || !title) return false;
  if (k === title) return true;
  return k.includes(' ') && keywordMatches(title, keyword);
}

/** 'YYYY' or 'YYYY-MM' -> a month index; anything else -> null. */
function monthIndex(date: string | undefined): number | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?/.exec(date?.trim() ?? '');
  if (!m) return null;
  return Number(m[1]) * 12 + (m[2] ? Math.max(0, Number(m[2]) - 1) : 0);
}

function nowIndex(now: Date): number {
  return now.getFullYear() * 12 + now.getMonth();
}

export function educationStatus(
  endDate: string | undefined,
  now: Date,
): EducationFact['status'] {
  if (!endDate?.trim()) return 'unknown';
  if (/present|current|ongoing|pursuing/i.test(endDate)) return 'in-progress';
  const end = monthIndex(endDate);
  if (end === null) return 'unknown';
  return end > nowIndex(now) ? 'in-progress' : 'completed';
}

/**
 * Total work history in years, to one decimal, with overlapping roles counted once.
 *
 * Summing role lengths would double-count a freelance practice run alongside a job;
 * taking earliest-start-to-now (the assembler's rough estimate) would count gaps as
 * experience. Merging the intervals answers the question a hiring manager actually asks.
 */
export function yearsOfWork(roles: RoleRecord[], now: Date): number {
  const current = nowIndex(now);
  const spans = roles
    .map((r) => {
      const start = monthIndex(r.startDate);
      const end = r.endDate === 'present' ? current : monthIndex(r.endDate);
      if (start === null || end === null || end < start) return null;
      return [start, Math.min(end, current)] as [number, number];
    })
    .filter((s): s is [number, number] => s !== null)
    .sort((a, b) => a[0] - b[0]);

  let months = 0;
  let open: [number, number] | null = null;
  for (const span of spans) {
    if (open && span[0] <= open[1] + 1) {
      open[1] = Math.max(open[1], span[1]);
    } else {
      if (open) months += open[1] - open[0] + 1;
      open = [...span];
    }
  }
  if (open) months += open[1] - open[0] + 1;

  return Math.round((months / 12) * 10) / 10;
}

/* ---------------------------------------------------------------- digest -- */

function clip(s: string | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Whether a description only restates the title — same words, ignoring case and punctuation. */
function sameText(a: string | undefined, b: string): boolean {
  const n = (s: string) => normalizeForMatch(s).replace(/[.\-#+]/g, ' ').replace(/\s+/g, ' ').trim();
  return n(a ?? '') === n(b);
}

function range(start?: string, end?: string): string {
  if (!start && !end) return '';
  return ` (${start ?? '?'} → ${end ?? '?'})`;
}

function buildDigest(
  records: ProfileRecord[],
  roles: RoleRecord[],
  contact: ContactInfo,
  job: JobRequirement,
  now: Date,
): {
  digest: string;
  refs: FitFacts['refs'];
  refOf: Map<string, string>;
} {
  const refs: FitFacts['refs'] = {};
  const refOf = new Map<string, string>();
  const counters: Record<string, number> = {};

  const tag = (prefix: string, id: string, label: string, kind: string): string => {
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    const ref = `${prefix}${counters[prefix]}`;
    refs[ref] = { label, kind };
    refOf.set(id, ref);
    return ref;
  };

  const of = <T extends ProfileRecord['type']>(type: T) =>
    records.filter((r): r is Extract<ProfileRecord, { type: T }> => r.type === type);

  // How many of the posting's terms a record shares — decides which records the agent
  // reads in detail. Ties keep the profile's own order, so the result is stable.
  const relevance = (r: ProfileRecord) => {
    const text = normalizeForMatch(recordText(r));
    return job.atsKeywords.filter((k) => keywordMatches(text, k)).length;
  };
  const byRelevance = <T extends ProfileRecord>(list: T[]): T[] =>
    list
      .map((r, i) => ({ r, i, score: relevance(r) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.r);

  const lines: string[] = ['CANDIDATE PROFILE — every item has a ref in brackets'];
  if (contact.location) lines.push(`Location: ${contact.location}`);

  const years = yearsOfWork(roles, now);
  lines.push('', `Work history (${years} years in total, overlaps counted once):`);
  if (roles.length === 0) lines.push('(none listed)');
  for (const r of roles) {
    const label = `${r.title} — ${r.company}`;
    lines.push(`[${tag('W', r.id, label, 'role')}] ${label}${range(r.startDate, r.endDate)}`);
  }

  lines.push('', 'Education:');
  const education = of('education');
  if (education.length === 0) lines.push('(none listed)');
  for (const e of education) {
    const label = [e.credential, e.field].filter(Boolean).join(', ');
    const status = educationStatus(e.endDate, now);
    lines.push(
      `[${tag('E', e.id, label || e.institution, 'education')}] ${label || '(credential not given)'} — ${e.institution}${range(e.startDate, e.endDate)}, ${status}`,
    );
  }

  const skills = of('skill');
  if (skills.length > 0) {
    lines.push(
      '',
      `Skills: ${skills.map((s) => `[${tag('K', s.id, s.name, 'skill')}] ${s.name}`).join('; ')}`,
    );
  }

  const projects = byRelevance(of('project'));
  if (projects.length > 0) {
    lines.push('', 'Projects most relevant to this job:');
    for (const p of projects.slice(0, DETAILED_PROJECTS)) {
      const stack = p.stack.length ? ` — ${p.stack.slice(0, 5).join(', ')}` : '';
      const desc = p.description ? ` — ${clip(p.description, PROJECT_DESC_CHARS)}` : '';
      lines.push(`[${tag('P', p.id, p.name, 'project')}] ${p.name}${stack}${desc}`);
    }
    const rest = projects.slice(DETAILED_PROJECTS);
    if (rest.length > 0) {
      lines.push(
        `Other projects: ${rest.map((p) => `[${tag('P', p.id, p.name, 'project')}] ${p.name}`).join('; ')}`,
      );
    }
  }

  const bullets = byRelevance(of('experience-bullet'));
  if (bullets.length > 0) {
    lines.push('', 'Experience bullets:');
    for (const b of bullets.slice(0, MAX_BULLETS)) {
      lines.push(`[${tag('B', b.id, clip(b.text, 60), 'experience-bullet')}] ${clip(b.text, BULLET_CHARS)}`);
    }
  }

  const certs = byRelevance(of('certification'));
  if (certs.length > 0) {
    lines.push(
      '',
      `Certifications: ${certs.map((c) => `[${tag('C', c.id, c.name, 'certification')}] ${c.name}`).join('; ')}`,
    );
  }

  const honours = byRelevance([...of('achievement'), ...of('award')]);
  if (honours.length > 0) {
    lines.push('', 'Achievements and awards:');
    for (const a of honours.slice(0, MAX_HONOURS)) {
      // Imported achievements often repeat their title as their description — "First
      // Prize in Debugging — First Prize in Debugging" — which spent the characters that
      // pushed the last two achievements past the cap on a real profile.
      const adds = a.description && !sameText(a.description, a.title);
      lines.push(
        `[${tag('A', a.id, a.title, a.type)}] ${a.title}${adds ? ` — ${clip(a.description, HONOUR_DESC_CHARS)}` : ''}`,
      );
    }
  }

  const published = [...of('publication'), ...of('writing')];
  if (published.length > 0) {
    lines.push(
      '',
      `Publications and writing: ${published.map((p) => `[${tag('R', p.id, p.title, p.type)}] ${p.title}`).join('; ')}`,
    );
  }

  const summary = of('summary')[0];
  if (summary?.text.trim()) {
    lines.push('', `Summary: [${tag('S', summary.id, 'Profile summary', 'summary')}] ${clip(summary.text, SUMMARY_CHARS)}`);
  }

  const other = [
    ...of('language').map((l) => `[${tag('L', l.id, l.name, 'language')}] ${l.name}${l.proficiency ? ` (${l.proficiency})` : ''}`),
    ...of('volunteering').map((v) => `[${tag('V', v.id, `${v.role} — ${v.organization}`, 'volunteering')}] ${v.role} — ${v.organization}`),
  ];
  if (other.length > 0) lines.push('', `Other: ${other.join('; ')}`);

  let digest = lines.join('\n');
  if (digest.length > MAX_DIGEST_CHARS) {
    digest = `${digest.slice(0, MAX_DIGEST_CHARS)}\n(profile truncated for length)`;
  }
  return { digest, refs, refOf };
}
