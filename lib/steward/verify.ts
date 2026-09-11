/**
 * The gate between the steward's model and the user — STEWARD.md §3.
 *
 * The agent (./agent.ts) is asked to propose only rewordings, re-filings, merges and
 * removals, and never a new fact. This module is why that is a guarantee rather than a
 * request: every proposal is checked in code against the record it concerns, and anything
 * that fails is dropped before a person ever sees it. A dropped proposal costs nothing; a
 * shown one that invents a figure costs the product its one promise (NFR-8).
 *
 * Pure, so every refusal below is pinned by a test.
 */

import { findUngroundedTokens } from '../generate/grounding';
import { SKILL_CATEGORIES as CATEGORIES, SKILL_CATEGORY_LABELS } from '../skills/categories';
import { formFor } from '../profile/forms';
import { labelOf, words } from './rules';
import { tidyText } from './tidy';
import {
  sectionOf,
  suggestionId,
  type StewardRecord,
  type StewardRole,
  type Suggestion,
} from './types';

/** What the model returns, one entry per proposal. Every field present, '' when unused. */
export interface AgentProposal {
  recordId: string;
  action: 'rewrite' | 'recategorize' | 'merge' | 'remove' | 'move';
  field: string;
  value: string;
  listValue: string[];
  otherId: string;
  reason: string;
}

export { SKILL_CATEGORIES } from '../skills/categories';



/**
 * Which fields a rewrite may touch, per type.
 *
 * `prose` fields may be reworded. `name` fields may only change case, spacing and
 * punctuation — the letters are the identity of a certificate, a degree or a skill, and
 * a model "correcting" one is a model renaming someone's qualification.
 */
const REWRITABLE: Record<string, { prose: string[]; name: string[] }> = {
  'experience-bullet': { prose: ['text'], name: [] },
  project: { prose: ['description'], name: [] },
  summary: { prose: ['text'], name: [] },
  achievement: { prose: ['description'], name: ['title'] },
  award: { prose: ['description'], name: ['title'] },
  volunteering: { prose: ['description'], name: ['role', 'organization'] },
  certification: { prose: [], name: ['name', 'issuer'] },
  education: { prose: [], name: ['credential', 'institution', 'field'] },
  // No skill renames: every write already gives a skill its canonical spelling (./tidy.ts),
  // and the model "corrected" scikit-learn to Scikit-learn when asked.
};

const REMOVABLE = new Set(['skill', 'experience-bullet', 'interest']);

/**
 * A skill may be removed only when its name is filler rather than a keyword. Asked
 * freely, the model proposed removing Data Science, Web Development and Classification —
 * exactly the broad terms a posting and an ATS search for.
 */
const FILLER_SKILL = /(^|[^a-z])(technologies|technology stack|things|stuff|various|misc|miscellaneous|etc)([^a-z]|$)/i;

/** Moves whose target fields can be filled from the source without inventing anything. */
const MOVES: Record<string, Record<string, { build: (d: Record<string, unknown>) => Record<string, unknown>; ask?: { field: string; prompt: string; placeholder: string } }>> = {
  project: {
    publication: {
      build: (d) => ({ title: d.name, venue: '', status: 'published' }),
      ask: { field: 'venue', prompt: 'Where was it published?', placeholder: 'Emerald Publishing' },
    },
    writing: {
      build: (d) => ({ title: d.name, venue: '', url: Array.isArray(d.links) ? (d.links[0] ?? '') : '' }),
      ask: { field: 'venue', prompt: 'Where was it published?', placeholder: 'Medium' },
    },
  },
  education: {
    certification: {
      build: (d) => ({ name: d.credential, issuer: d.institution, issuedDate: d.endDate ?? '' }),
    },
  },
  certification: {
    education: {
      build: (d) => ({ credential: d.name, institution: d.issuer, endDate: d.issuedDate ?? '' }),
    },
  },
};

/** First- and second-person words, which a resume line never needs. */
const PERSONAL = new Set(['i', 'me', 'my', 'mine', 'we', 'our', 'us', 'you', 'your', 'yours']);

const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Every string a record says, which is all a rewrite of it may draw on. */
function sourceText(record: StewardRecord, role?: StewardRole): string {
  const parts: string[] = [];
  for (const v of Object.values(record.data)) {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) parts.push(...v.filter((x): x is string => typeof x === 'string'));
  }
  if (role) parts.push(role.title, role.company);
  return parts.join('. ');
}

export interface VerifyResult {
  suggestions: Suggestion[];
  /** Why each refused proposal was refused — logged, never shown. */
  refused: string[];
}

/**
 * Turns model proposals into suggestions, keeping only what survives every check.
 *
 * @param records the batch the model was shown; a proposal about anything else is refused.
 * @param taken  suggestions already made by the rules, so the agent does not repeat them
 *               or contradict them (a bullet the rules propose removing is not reworded).
 */
export function verifyProposals(
  proposals: AgentProposal[],
  records: StewardRecord[],
  roles: StewardRole[],
  taken: Suggestion[] = [],
): VerifyResult {
  const byId = new Map(records.map((r) => [r.id, r]));
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const busy = new Set(
    taken.flatMap((s) => (s.kind === 'fix' ? [] : [s.recordId, ...(s.removeIds ?? [])])),
  );
  const fixedFields = new Set(
    taken.flatMap((s) => Object.keys(s.changes ?? {}).map((f) => `${s.recordId}:${f}`)),
  );
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  const refused: string[] = [];
  const refuse = (p: AgentProposal, why: string) => refused.push(`${p.action} ${p.recordId}: ${why}`);

  for (const p of proposals) {
    const record = byId.get(p.recordId);
    if (!record) { refuse(p, 'unknown record'); continue; }
    if (busy.has(record.id)) { refuse(p, 'the rules already propose something for it'); continue; }
    const key = `${p.action}:${record.id}:${p.field}`;
    if (seen.has(key)) { refuse(p, 'duplicate proposal'); continue; }

    const base = {
      section: sectionOf(record.type),
      recordId: record.id,
      recordType: record.type,
      label: labelOf(record),
      origin: 'ai' as const,
      quick: false,
      reason: tidyText(p.reason).slice(0, 240) || 'Suggested by the profile assistant.',
      basis: { [record.id]: record.contentHash },
    };
    let draft: Omit<Suggestion, 'id'> | null = null;

    if (p.action === 'rewrite') {
      const allowed = REWRITABLE[record.type];
      const isProse = allowed?.prose.includes(p.field);
      const isName = allowed?.name.includes(p.field);
      const isStack = record.type === 'project' && p.field === 'stack';
      if (!isProse && !isName && !isStack) { refuse(p, `field ${p.field} is not rewritable on ${record.type}`); continue; }
      if (fixedFields.has(`${record.id}:${p.field}`)) { refuse(p, 'the rules already fix this field'); continue; }

      if (isStack) {
        const before = Array.isArray(record.data.stack) ? (record.data.stack as string[]) : [];
        const after = p.listValue.map(tidyText).filter(Boolean);
        const known = new Set(before.map(bare));
        // A stack may only lose entries — never gain one the project did not list.
        if (after.length === 0 || after.length >= before.length || !after.every((a) => known.has(bare(a)))) {
          refuse(p, 'a stack rewrite may only remove entries');
          continue;
        }
        draft = { ...base, kind: 'fix', title: 'Keep only the technologies in the stack', changes: { stack: { from: before, to: after } } };
      } else {
        const before = String(record.data[p.field] ?? '');
        const after = tidyText(p.value);
        if (!after || after === tidyText(before)) { refuse(p, 'no change'); continue; }

        if (isName) {
          if (bare(after) !== bare(before)) { refuse(p, 'a name may only change case or punctuation'); continue; }
          draft = { ...base, kind: 'fix', title: `Write as “${after}”`, changes: { [p.field]: { from: before, to: after } } };
        } else {
          // Structured bullets keep their structure: rewording the joined text would
          // flatten the scale and outcome the user entered separately.
          if (record.type === 'experience-bullet' && (record.data.scale || record.data.outcome)) {
            refuse(p, 'bullet has structured parts');
            continue;
          }
          if (!before.trim()) { refuse(p, 'nothing to reword'); continue; }
          if (after.length > before.length * 1.25 + 20) { refuse(p, 'rewrite grew the text'); continue; }
          const role = roleById.get(String(record.data.roleId ?? ''));
          const invented = findUngroundedTokens(after, sourceText(record, role));
          if (invented.length > 0) {
            refuse(p, `introduces ${invented.map((v) => v.token).join(', ')}`);
            continue;
          }
          const addedPersonal = words(after).filter((w) => PERSONAL.has(w) && !words(before).includes(w));
          if (addedPersonal.length > 0) { refuse(p, 'adds first or second person'); continue; }
          draft = { ...base, kind: 'fix', title: 'Reword', changes: { [p.field]: { from: before, to: after } } };
        }
      }
    } else if (p.action === 'recategorize') {
      if (record.type !== 'skill') { refuse(p, 'only skills have categories'); continue; }
      if (!(CATEGORIES as readonly string[]).includes(p.value) || p.value === record.data.category) {
        refuse(p, 'category not valid or unchanged');
        continue;
      }
      draft = {
        ...base,
        kind: 'fix',
        title: `File under ${SKILL_CATEGORY_LABELS[p.value as keyof typeof SKILL_CATEGORY_LABELS]}`,
        changes: { category: { from: record.data.category ?? '', to: p.value } },
      };
    } else if (p.action === 'merge') {
      const keep = byId.get(p.otherId);
      if (!keep || keep.id === record.id || keep.type !== record.type || record.type !== 'skill') {
        refuse(p, 'merge target missing or of another type');
        continue;
      }
      if (busy.has(keep.id)) { refuse(p, 'the rules already propose something for the target'); continue; }
      // Only names that visibly share something: a word, or one being the other's initials.
      const a = String(record.data.name ?? '');
      const b = String(keep.data.name ?? '');
      const wa = words(a);
      const wb = words(b);
      const initials = (w: string[]) => w.map((x) => x[0]).join('');
      const related =
        wa.some((w) => w.length > 1 && wb.includes(w)) ||
        initials(wb) === wa.join('') ||
        initials(wa) === wb.join('');
      if (!related) { refuse(p, `"${a}" and "${b}" share nothing`); continue; }
      draft = {
        ...base,
        kind: 'merge',
        recordId: keep.id,
        label: labelOf(keep),
        title: `Merge “${a}” into “${b}”`,
        removeIds: [record.id],
        basis: { [record.id]: record.contentHash, [keep.id]: keep.contentHash },
      };
      busy.add(keep.id);
    } else if (p.action === 'remove') {
      if (!REMOVABLE.has(record.type)) { refuse(p, `${record.type} is not removable here`); continue; }
      if (record.type === 'skill' && !FILLER_SKILL.test(String(record.data.name ?? ''))) {
        refuse(p, `"${String(record.data.name)}" is a real keyword`);
        continue;
      }
      draft = { ...base, kind: 'remove', title: 'Remove' };
    } else if (p.action === 'move') {
      const move = MOVES[record.type]?.[p.value];
      if (!move) { refuse(p, `cannot move ${record.type} to ${p.value}`); continue; }
      const data = move.build(record.data);
      draft = {
        ...base,
        kind: 'move',
        title: `Move to ${formFor(p.value)?.plural ?? p.value}`,
        moveTo: { type: p.value, data },
        ...(move.ask ? { ask: move.ask } : {}),
      };
    } else {
      refuse(p, 'unknown action');
      continue;
    }

    seen.add(key);
    busy.add(record.id);
    suggestions.push({ ...draft, id: suggestionId(draft) });
  }

  return { suggestions, refused };
}
