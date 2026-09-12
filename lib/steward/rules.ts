/**
 * What the steward can prove without a model — STEWARD.md §3, layer 2, rules half.
 *
 * Pure: a profile in, suggestions out. Every rule here was written against a defect in
 * the owner's real profile, and each is conservative in the same direction — a missed
 * duplicate costs a line on a resume, a wrong merge costs a fact, so a rule only fires
 * when the code can show its working.
 */

import { describeRecord, formFor } from '../profile/forms';
import { canonicalSkillName, skillIdentity } from '../skills/identity';
import { ACRONYMS, SKILL_CATEGORY_LABELS, classifySkill } from '../skills/categories';
import { tidyRecordData, tidyText } from './tidy';
import { duplicateRecords } from './duplicates';
import {
  sectionOf,
  suggestionId,
  type StewardProfile,
  type StewardRecord,
  type StewardRole,
  type Suggestion,
} from './types';

type Draft = Omit<Suggestion, 'id'>;
const done = (d: Draft): Suggestion => ({ ...d, id: suggestionId(d) });

/** Lowercase words of letters and digits. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

export function labelOf(record: StewardRecord): string {
  const form = formFor(record.type);
  const name =
    record.type === 'experience-bullet'
      ? String(record.data.text ?? '')
      : describeRecord(record.type, record.data);
  const short = name.length > 70 ? `${name.slice(0, 67)}…` : name;
  return `${form?.singular ? form.singular[0].toUpperCase() + form.singular.slice(1) : 'Bullet'} · ${short}`;
}

/* --------------------------------------------------------------- hygiene -- */

const BULLET_TEXT_FIELDS = ['text', 'action', 'scale', 'outcome'];

/**
 * Typography and casing already in the profile. New writes are tidied on the way in
 * (./tidy.ts); this offers the same to everything stored before that existed.
 */
function hygiene(record: StewardRecord): Draft | null {
  const before = record.data;
  let after: Record<string, unknown>;
  if (record.type === 'experience-bullet') {
    after = { ...before };
    for (const f of BULLET_TEXT_FIELDS) {
      if (typeof before[f] === 'string') after[f] = tidyText(before[f] as string);
    }
  } else {
    after = tidyRecordData(record.type, before);
  }

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'source') continue;
    if (JSON.stringify(before[key] ?? '') !== JSON.stringify(after[key] ?? '')) {
      changes[key] = { from: before[key] ?? '', to: after[key] ?? '' };
    }
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) return null;

  let title = 'Fix spacing and symbols';
  let reason = 'Look-alike characters and stray spaces that print badly or confuse an ATS.';
  if (keys.length === 1 && keys[0] === 'description' && !after.description) {
    title = 'Drop the description that repeats the title';
    reason = 'The same words twice read as a template filled in without looking.';
  } else if (record.type === 'skill' && keys.length === 1 && keys[0] === 'name') {
    title = `Write as “${String(changes.name.to)}”`;
    reason = 'Consistent capitals across the Skills line; the skill itself is unchanged.';
  } else if (keys.length === 1 && keys[0] === 'stack') {
    title = 'Tidy the stack';
    reason = 'The same technology listed twice, or spelled inconsistently.';
  }

  return {
    kind: 'fix',
    section: sectionOf(record.type),
    recordId: record.id,
    recordType: record.type,
    label: labelOf(record),
    title,
    reason,
    origin: 'rule',
    quick: true,
    changes,
    basis: { [record.id]: record.contentHash },
  };
}

/* -------------------------------------------------------- duplicate skills -- */

/** "databases" → "database"; leaves "analysis", "class", "status" alone. */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Every key under which two spellings of one skill would meet. */
export function skillKeys(name: string): string[] {
  const keys = new Set<string>([`id:${skillIdentity(name)}`]);
  // A symbol is part of the name: "C++", "C#" and "C" are three languages, and stripping
  // the symbol to compare words would merge them. Such names meet only by identity.
  if (/[+#.]/.test(name)) return [...keys];
  const add = (s: string) => {
    const w = words(s).map(singular).join(' ');
    if (!w) return;
    keys.add(w);
    if (ACRONYMS[w]) keys.add(ACRONYMS[w]);
  };
  add(name);
  // "Natural Language Processing (NLP)" is both of its halves.
  const paren = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(name);
  if (paren) {
    add(paren[1]);
    add(paren[2]);
  }
  return [...keys];
}

function duplicateSkills(skills: StewardRecord[]): Draft[] {
  const parent = skills.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstByKey = new Map<string, number>();
  skills.forEach((s, i) => {
    for (const key of skillKeys(String(s.data.name ?? ''))) {
      const j = firstByKey.get(key);
      if (j === undefined) firstByKey.set(key, i);
      else parent[find(i)] = find(j);
    }
  });

  const groups = new Map<number, StewardRecord[]>();
  skills.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));

  // The one kept is the fullest telling: "Natural Language Processing (NLP)" carries both
  // spellings an ATS may search for. An approved record beats a pending one, and one the
  // user typed beats one a parser wrote.
  const keepScore = (s: StewardRecord) => {
    const name = String(s.data.name ?? '');
    return (
      (/\([^()]+\)\s*$/.test(name) ? 4 : 0) +
      // The table's own spelling: "React" over "React.js".
      (canonicalSkillName(name) === name ? 3 : 0) +
      (s.reviewState === 'approved' ? 2 : 0) +
      (s.source === 'manual' ? 1 : 0) +
      Math.min(name.length, 60) / 100
    );
  };

  const out: Draft[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort((a, b) => keepScore(b) - keepScore(a));
    const names = rest.map((r) => `“${String(r.data.name)}”`).join(', ');
    out.push({
      kind: 'merge',
      section: 'skills',
      recordId: keep.id,
      recordType: 'skill',
      label: labelOf(keep),
      title: `Merge ${names} into “${String(keep.data.name)}”`,
      reason: 'The same skill listed more than once takes Skills-line space and reads as padding.',
      origin: 'rule',
      quick: false,
      removeIds: rest.map((r) => r.id),
      basis: Object.fromEntries(group.map((r) => [r.id, r.contentHash])),
    });
  }
  return out;
}

/**
 * A skill filed as something it is not.
 *
 * Every parser had five categories and no home for a technique, so Machine Learning was a
 * "framework", Statistics a "tool", and Web Development and SEO "soft skills". The table
 * in ../skills/categories.ts answers only where the answer is not in doubt, so a skill it
 * does not recognise is never questioned.
 */
function skillCategories(skills: StewardRecord[]): Draft[] {
  const out: Draft[] = [];
  for (const skill of skills) {
    const name = String(skill.data.name ?? '');
    const hit = classifySkill(name);
    if (!hit || hit.category === skill.data.category) continue;
    const want = hit.category;
    out.push({
      kind: 'fix',
      section: 'skills',
      recordId: skill.id,
      recordType: 'skill',
      label: labelOf(skill),
      title: `File under ${SKILL_CATEGORY_LABELS[want]}`,
      reason:
        want === 'method'
          ? `"${name}" is something you know how to do, not a library or a tool.`
          : `"${name}" is an interpersonal skill rather than a technical one.`,
      origin: 'rule',
      // A named match is certain and changes no fact, so it can go with the other quick
      // fixes; a guess from the shape of the name is shown on its own.
      quick: hit.confidence === 'high',
      changes: { category: { from: skill.data.category ?? '', to: want } },
      basis: { [skill.id]: skill.contentHash },
    });
  }
  return out;
}

/* ------------------------------------------------------------- bullets -- */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'as',
  'from', 'into', 'across', 'through', 'them', 'their', 'it', 'its', 'using', 'via',
]);

/** Openers that describe presence rather than work. */
export const WEAK_OPENERS = new Set([
  'helped', 'worked', 'assisted', 'contributed', 'participated', 'involved', 'offered',
  'responsible', 'handled', 'did', 'was', 'tasked', 'supported',
]);

const content = (text: string) => new Set(words(text).filter((w) => !STOPWORDS.has(w)));

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

const MONTH_WORDS = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june',
  'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov',
  'november', 'dec', 'december', 'present', 'until', 'till', 'since',
]);

/** A bullet that restates the role's own dates and says nothing else. */
export function isDatesOnly(text: string, role?: StewardRole): boolean {
  const all = words(text);
  if (all.length === 0 || all.length > 8) return false;
  if (!all.some((w) => MONTH_WORDS.has(w) || /^(19|20)\d{2}$/.test(w))) return false;
  const roleWords = role ? words(`${role.title} ${role.company}`) : [];
  const rest = all.filter(
    (w) =>
      !STOPWORDS.has(w) &&
      !MONTH_WORDS.has(w) &&
      !/^\d+$/.test(w) &&
      !roleWords.some((r) => r.slice(0, 6) === w.slice(0, 6)),
  );
  return rest.length <= 1;
}

function bulletRules(bullets: StewardRecord[], roles: StewardRole[]): Draft[] {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const roleName = (b: StewardRecord) => {
    const r = roleById.get(String(b.data.roleId ?? ''));
    return r ? `${r.title} at ${r.company}` : 'another role';
  };
  const out: Draft[] = [];
  const removed = new Set<string>();

  for (const b of bullets) {
    const role = roleById.get(String(b.data.roleId ?? ''));
    if (isDatesOnly(String(b.data.text ?? ''), role)) {
      removed.add(b.id);
      out.push({
        kind: 'remove',
        section: 'experience',
        recordId: b.id,
        recordType: 'experience-bullet',
        label: labelOf(b),
        title: 'Remove this line',
        reason: 'It only repeats the dates already printed beside the role.',
        origin: 'rule',
        quick: false,
        basis: { [b.id]: b.contentHash },
      });
    }
  }

  const sets = bullets.map((b) => content(String(b.data.text ?? '')));
  for (let i = 0; i < bullets.length; i++) {
    for (let j = i + 1; j < bullets.length; j++) {
      const [a, b] = [bullets[i], bullets[j]];
      if (removed.has(a.id) || removed.has(b.id)) continue;
      if (sets[i].size < 4 || sets[j].size < 4 || jaccard(sets[i], sets[j]) < 0.6) continue;

      const weakness = (r: StewardRecord, s: Set<string>) =>
        (WEAK_OPENERS.has(words(String(r.data.text ?? ''))[0] ?? '') ? 10 : 0) +
        (r.source === 'manual' ? -1 : 0) -
        s.size / 100;
      const [drop, keep] =
        weakness(a, sets[i]) >= weakness(b, sets[j]) ? [a, b] : [b, a];
      removed.add(drop.id);
      out.push({
        kind: 'remove',
        section: 'experience',
        recordId: drop.id,
        recordType: 'experience-bullet',
        label: labelOf(drop),
        title: 'Remove the repeated bullet',
        reason: `It says the same as “${String(keep.data.text)}” under ${roleName(keep)}.`,
        origin: 'rule',
        quick: false,
        basis: { [drop.id]: drop.contentHash, [keep.id]: keep.contentHash },
      });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- asks -- */

function asks(profile: StewardProfile): Draft[] {
  const out: Draft[] = [];
  const ask = (
    record: StewardRecord,
    field: string,
    title: string,
    prompt: string,
    placeholder: string,
    reason: string,
  ): Draft => ({
    kind: 'ask',
    section: sectionOf(record.type),
    recordId: record.id,
    recordType: record.type,
    label: labelOf(record),
    title,
    reason,
    origin: 'rule',
    quick: false,
    ask: { field, prompt, placeholder },
    basis: { [record.id]: record.contentHash },
  });

  for (const r of profile.records) {
    const d = r.data;
    const empty = (f: string) =>
      Array.isArray(d[f]) ? (d[f] as unknown[]).length === 0 : !String(d[f] ?? '').trim();
    if (r.type === 'project' && empty('stack')) {
      out.push(ask(r, 'stack', 'Add what it was built with', 'What was it built with?', 'Python, Flask, PostgreSQL', 'A project line with no technologies gives an ATS nothing to match.'));
    }
    if (r.type === 'certification' && empty('issuedDate')) {
      out.push(ask(r, 'issuedDate', 'Add when you earned it', 'When did you earn it?', '2024-06', 'Undated certificates look unfinished, and recency is how they are ranked.'));
    }
    if (r.type === 'education' && empty('endDate')) {
      out.push(ask(r, 'endDate', 'Add when it ends', 'When did it end, or when will it?', '2027-05', 'An education entry with no end date leaves a recruiter guessing whether you finished.'));
    }
  }

  const bulletRoles = new Set(
    profile.records.filter((r) => r.type === 'experience-bullet').map((r) => String(r.data.roleId ?? '')),
  );
  for (const role of profile.roles) {
    if (bulletRoles.has(role.id)) continue;
    out.push({
      kind: 'ask',
      section: 'experience',
      recordId: role.id,
      recordType: 'role',
      label: `Role · ${role.title} at ${role.company}`,
      title: 'Say what you did here',
      reason: 'A role with nothing under it prints as a title and dates only.',
      origin: 'rule',
      quick: false,
      ask: {
        field: 'bullet',
        prompt: `What did you do as ${role.title} at ${role.company}?`,
        placeholder: 'Built the admissions chatbot used by 2,000 applicants',
      },
      basis: { [role.id]: `${role.title}|${role.company}|${role.startDate}|${role.endDate}` },
    });
  }
  return out;
}

/* ---------------------------------------------------------------- entry -- */

/** Every rule over the whole profile, or one section of it. */
export function ruleSuggestions(
  profile: StewardProfile,
  section?: Suggestion['section'],
): Suggestion[] {
  const live = profile.records.filter((r) => r.reviewState !== 'rejected');
  const drafts: Draft[] = [
    ...live.map(hygiene).filter((d): d is Draft => d !== null),
    ...duplicateSkills(live.filter((r) => r.type === 'skill')),
    ...skillCategories(live.filter((r) => r.type === 'skill')),
    ...bulletRules(live.filter((r) => r.type === 'experience-bullet'), profile.roles),
    // Every other section's duplicates — see ./duplicates.ts for why they occur at all.
    ...duplicateRecords(live, (r) => labelOf(r), sectionOf),
    ...asks({ records: live, roles: profile.roles.filter((r) => r.reviewState !== 'rejected') }),
  ];
  return drafts.filter((d) => !section || d.section === section).map(done);
}
