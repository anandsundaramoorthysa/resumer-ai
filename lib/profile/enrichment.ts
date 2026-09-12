/**
 * Turning a draft's own complaints into questions only the user can answer.
 *
 * The pipeline already computes, per record, exactly what is missing — and then throws
 * all three signals away:
 *
 *   - `lib/generate/assemble.ts` counts how many grounded rewrites were REFUSED. Each
 *     one is a bullet the model believed it could strengthen and the grounding check
 *     stopped, which is the sharpest available statement of "this line would land if you
 *     could evidence it". It became a number in a progress line.
 *   - `lib/quality/evidence.ts` returns `weakBullets`, each carrying the grader's own
 *     account of what is absent. It became a critique the revision pass then proved it
 *     could not act on — see `unimprovable` in lib/quality/loop.ts, which exists purely
 *     to stop the loop paying to rediscover that.
 *   - `lib/quality/skills.ts` returns `genuineGaps`, the keywords the posting demands
 *     that the profile cannot back. It became one sentence in the halt explanation.
 *
 * All three describe the same thing from different angles: a fact the user has and the
 * profile does not record. Nothing downstream can invent it — that is the whole point of
 * NFR-8 — so the only honest move left is to ask, and to ask about ONE specific line at
 * a time rather than opening a blank bullet editor and hoping.
 *
 * This module is pure so the rule can be tested without a database or a model. It never
 * writes and never phrases anything the user did not already say: a question quotes the
 * user's own bullet and the grader's own words, and asks for a dimension by name.
 *
 * What it deliberately does NOT do: suggest an answer, show the figure a rejected
 * rewrite wanted to use, or infer a plausible metric from context. Any of those would
 * turn "we cannot evidence this" into "here is the number, confirm it" — which is
 * fabrication with an extra click, and would leave every downstream grounding check
 * verifying against a figure the model chose (NFR-8).
 */

import type { JobRequirement, ProfileRecord, ResumeDocument, RoleRecord } from '../types';
import { hasMeasurableOutcome } from './gaps';
import { profileVocabulary } from '../quality/skills';
import { holdsKeyword } from '../quality/vocabulary';
import { canonicalSkillName, skillAliases } from '../skills/identity';
import { classifyRecordType } from './record-type';
import { DEFAULT_CAPS, rankRecords, selectTop } from '../retrieval/rank';

/* ----------------------------------------------------------------- volume -- */

/**
 * How many questions one draft may ADD.
 *
 * A thin profile — ten roles with bullets on two, thirty-two projects with one metric
 * between them — produces well over thirty gaps on its first draft. Handing someone
 * thirty writing prompts is not a queue, it is homework, and homework gets closed. Six
 * is the most a single draft may add to the backlog, so the queue grows at the rate the
 * user is actually generating resumes rather than all at once.
 */
export const MAX_NEW_QUESTIONS_PER_DRAFT = 6;

/**
 * The most questions that may be outstanding at all.
 *
 * Past this the backlog is longer than anyone will ever reach, and a new draft's
 * findings — which are about the job being applied for *now* — would queue behind stale
 * ones. So the backlog stops growing and the ordering below decides what is worth
 * asking; a question that never got written is not lost, because the next draft that
 * hits the same gap re-derives it.
 */
export const MAX_OPEN_QUESTIONS = 20;

/**
 * How many are shown on /profile at once.
 *
 * Deliberately far below the backlog cap, and below what the two review queues next door
 * show. Those cost one click per item; this costs a sentence of writing per item, which
 * is an order of magnitude more expensive — a list of twenty reads as a wall and gets
 * answered zero times. Three fits one screen, takes a couple of minutes, and each answer
 * measurably moves the next draft. The rest are counted, not listed, so the number stays
 * honest without being the thing you have to look at.
 */
export const QUESTIONS_SHOWN = 3;

/**
 * Half of whatever allowance is being spent, rounded up.
 *
 * See `rationedSlice`. Exported because both callers' behaviour is a consequence of it,
 * and a test that hard-codes 3 would pass while the rule it is checking changed.
 */
export function rationPerKind(limit: number): number {
  return Math.ceil(limit / 2);
}

/* ------------------------------------------------------------------ shape -- */

export type QuestionKind = 'bullet' | 'project' | 'skill';

/** The two dimensions `lib/quality/evidence.ts` grades a bullet on. */
export type BulletPart = 'scale' | 'outcome';

/**
 * Everything a draft learned about what it could not evidence.
 *
 * Assembled by the pipeline and handed out whole, rather than each producer writing its
 * own questions: only here is it visible that a refused rewrite and a weak-bullet flag
 * on the same line are one question, not two.
 */
export interface EnrichmentSignal {
  /** Bullets whose rewrite the grounding check refused, by profile record id. */
  rejectedRewrites: Array<{ recordId: string; text: string }>;
  /** What the evidence grader said was absent, positioned in the finished document. */
  weakBullets: Array<{
    sectionKey: string;
    itemIndex: number;
    text: string;
    problem: string;
  }>;
  /** Keywords the posting demands that the profile cannot back (REQ-5.5). */
  genuineGaps: string[];
  /** The finished document — the only thing that maps a printed line to its record. */
  document: ResumeDocument | null;
  /** For the "why you are being asked" line, and for ordering by what the job wants. */
  job: JobRequirement | null;
}

export interface DraftedQuestion {
  /**
   * Dedupe identity: one open question per subject, whatever signal produced it.
   *
   * It names the subject and NOT the deficiency, on purpose. A bullet missing both its
   * scale and its outcome, later filled in halfway, would otherwise arrive as a second
   * row asking for the other half — two entries in the queue for one line of one resume.
   */
  subjectKey: string;
  kind: QuestionKind;
  /** The profile record the answer will be written into. Null only for a skill gap. */
  recordId: string | null;
  /** For a skill question, the keyword. Empty otherwise. */
  topic: string;
  /** The user's own words, so the question is about something they recognise. */
  quote: string;
  /** Where those words live: "Engineer — Acme", the project's stack, or the posting. */
  context: string;
  /** The signal's own account of what is absent — never this module's paraphrase. */
  reason: string;
  priority: number;
}

/* --------------------------------------------------------------- priority -- */

/**
 * What each signal is worth, highest first.
 *
 * The order is the sub-score weights (skills 0.40, evidence 0.30) read back as advice: a
 * keyword the posting demands and the profile cannot evidence is both the heaviest thing
 * on the scoreboard and the documented reason the loop halts, so it outranks everything.
 * A refused rewrite comes next because it is the only signal naming a line the model had
 * already decided it could strengthen — an answer there converts directly into a better
 * bullet on this same resume. A merely weak bullet is a lower bid: the grader thinks it
 * is thin, but nothing tried and failed to fix it.
 */
export const IMPACT = {
  skillGap: 100,
  rejectedRewrite: 70,
  weakBoth: 50,
  weakOne: 40,
  projectNoOutcome: 30,
} as const;

/**
 * How much a keyword's position in the posting is worth.
 *
 * `requiredSkills` and `atsKeywords` arrive roughly in the order the posting states its
 * requirements, so the first few are what the role is actually for and the twentieth is
 * a nice-to-have. Twenty points of spread sorts gaps sensibly against each other while
 * still keeping every one of them above every rejected rewrite.
 */
export function keywordDemandBonus(job: JobRequirement | null, keyword: string): number {
  if (!job) return 0;
  const wanted = [...job.requiredSkills, ...job.atsKeywords].map((k) =>
    k.toLowerCase().trim(),
  );
  const at = wanted.indexOf(keyword.toLowerCase().trim());
  if (at === -1) return 0;
  return Math.max(0, 20 - at);
}

/**
 * A bullet on the job you hold now is worth more than one on a 2019 internship — the
 * same judgement `distributeBulletsByRecency` already makes when it spends the page.
 * Small on purpose: it breaks ties between equal signals, it never outranks one.
 */
function recencyBonus(roles: RoleRecord[], roleId: string | undefined): number {
  if (!roleId) return 0;
  const rank = orderedRoleIds(roles).indexOf(roleId);
  return rank === -1 ? 0 : Math.max(0, 5 - rank);
}

/** Newest first, by end date then start date. Undated roles sort last. */
function orderedRoleIds(roles: RoleRecord[]): string[] {
  const idx = (d: string | undefined) => {
    const m = /^(\d{4})(?:-(\d{1,2}))?/.exec((d ?? '').trim());
    if (!m) return -1;
    return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0);
  };
  const end = (r: RoleRecord) => {
    const e = (r.endDate ?? '').trim().toLowerCase();
    if (e === 'present' || e === 'current' || e === 'ongoing') return Number.MAX_SAFE_INTEGER;
    return idx(r.endDate) >= 0 ? idx(r.endDate) : idx(r.startDate);
  };
  return [...roles]
    .sort((a, b) => end(b) - end(a) || idx(b.startDate) - idx(a.startDate))
    .map((r) => r.id);
}

/* ------------------------------------------------------ reading the signal -- */

/**
 * Which dimension the grader said was absent.
 *
 * `problem` is free text from a model — the schema asks for "scale, outcome,
 * specificity, or all three" and models answer in sentences. Matching on the vocabulary
 * the grader was given is enough; anything unrecognised is treated as both missing,
 * because a bullet called weak without a stated reason is a bullet with nothing specific
 * in it at all.
 */
export function deficienciesFrom(problem: string): BulletPart[] {
  const p = (problem ?? '').toLowerCase();
  const scale = /\bscale\b|how many|how much|how big|volume|size|throughput|audience/.test(p);
  const outcome =
    /\boutcome\b|\bresult\b|\bimpact\b|what changed|measurable|\bmetric|\beffect\b/.test(p);
  if (!scale && !outcome) return ['scale', 'outcome'];
  return [
    ...(scale ? (['scale'] as BulletPart[]) : []),
    ...(outcome ? (['outcome'] as BulletPart[]) : []),
  ];
}

/**
 * The record a printed line came from.
 *
 * Every item the assembler writes carries `sourceRecordId`, so the finished document is
 * the map between what the grader saw and what the user can edit. Matched on text rather
 * than on the grader's reported index: the revision pass rewrites items in place and a
 * grader is free to report a section key loosely, but the text it quotes is the text
 * that was in front of it.
 */
export function recordIdForText(doc: ResumeDocument | null, text: string): string | null {
  const target = (text ?? '').trim();
  if (!doc || !target) return null;
  for (const section of doc.sections) {
    for (const item of section.items) {
      if (item.text.trim() === target && item.sourceRecordId) return item.sourceRecordId;
    }
    for (const group of section.groups ?? []) {
      for (const item of group.items) {
        if (item.text.trim() === target && item.sourceRecordId) return item.sourceRecordId;
      }
    }
  }
  return null;
}

/* -------------------------------------------------- is the gap still open? -- */

/** The parts of a bullet that are still blank. */
export function missingBulletParts(record: ProfileRecord | undefined): BulletPart[] {
  if (!record || record.type !== 'experience-bullet') return [];
  const bullet = record as Extract<ProfileRecord, { type: 'experience-bullet' }>;
  return [
    ...(bullet.scale?.trim() ? [] : (['scale'] as BulletPart[])),
    ...(bullet.outcome?.trim() ? [] : (['outcome'] as BulletPart[])),
  ];
}

/**
 * Whether a question still has anything to ask about.
 *
 * Checked against the LIVE profile rather than against what the question stored, so a
 * gap the user closed somewhere else — in the bullet editor, in a project's outcomes
 * list, by adding the skill by hand — takes its question with it. A queue that keeps
 * asking for something already supplied is the fastest way to teach someone to ignore it.
 *
 * Deliberately the same predicates the scorers use: `hasMeasurableOutcome` for a project
 * (lib/profile/gaps.ts) and `holdsKeyword` over `profileVocabulary` for a skill
 * (lib/quality/skills.ts). A question that closed on a looser rule than the score opens
 * on would be re-derived by the next draft, and the queue would flicker.
 */
export function isGapOpen(
  question: { kind: QuestionKind; recordId: string | null; topic: string },
  records: ProfileRecord[],
): boolean {
  if (question.kind === 'skill') {
    const vocab = profileVocabulary(records.filter((r) => !r.flaggedForRemoval));
    return ![question.topic, ...skillAliases(question.topic)].some((s) =>
      holdsKeyword(vocab, s),
    );
  }

  const record = records.find((r) => r.id === question.recordId);
  // A record that no longer exists takes its question with it. The row itself goes by
  // foreign key; this is the same answer for anything that outran that.
  if (!record || record.flaggedForRemoval) return false;

  if (question.kind === 'bullet') return missingBulletParts(record).length > 0;

  if (record.type !== 'project') return false;
  const project = record as Extract<ProfileRecord, { type: 'project' }>;
  return !hasMeasurableOutcome(project.impactMetrics ?? []);
}

/* ----------------------------------------------------------- building them -- */

const MAX_QUOTE = 300;
const MAX_REASON = 240;

function clip(text: string, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function roleLabel(roles: RoleRecord[], roleId: string | undefined): string {
  const role = roles.find((r) => r.id === roleId);
  return role ? `${role.title} — ${role.company}` : '';
}

/**
 * Every question this draft's signal supports, best first.
 *
 * One pass per signal into a map keyed by subject, so the strongest claim on a given
 * record wins and the weaker ones contribute nothing but noise avoided. Volume is not
 * applied here — the caller decides what to keep, because only it knows what is already
 * in the queue.
 */
export function buildEnrichmentQuestions(
  signal: EnrichmentSignal,
  records: ProfileRecord[],
  roles: RoleRecord[],
): DraftedQuestion[] {
  const byKey = new Map<string, DraftedQuestion>();
  const jobLabel = signal.job?.roleTitle ? ` for the ${signal.job.roleTitle} posting` : '';
  const recordById = new Map(records.map((r) => [r.id, r]));

  const put = (q: DraftedQuestion) => {
    const existing = byKey.get(q.subjectKey);
    // Same line, two complaints. Keep the higher bid and the reason that goes with it —
    // the reason is what tells the user why this line and not another.
    if (!existing || q.priority > existing.priority) byKey.set(q.subjectKey, q);
  };

  // ---- 1. rewrites the grounding check refused --------------------------------
  for (const rejected of signal.rejectedRewrites) {
    const record = recordById.get(rejected.recordId);
    if (!record || record.type !== 'experience-bullet') continue;
    if (missingBulletParts(record).length === 0) continue;

    const bullet = record as Extract<ProfileRecord, { type: 'experience-bullet' }>;
    put({
      subjectKey: `bullet:${record.id}`,
      kind: 'bullet',
      recordId: record.id,
      topic: '',
      quote: clip(bullet.text, MAX_QUOTE),
      context: roleLabel(roles, bullet.roleId),
      // Says what happened without saying what the rewrite wanted to write. Naming the
      // figure it reached for would be handing the user a number to agree with.
      reason: clip(
        `A rewrite${jobLabel} tried to strengthen this line and was refused: it would have added something your profile does not state.`,
        MAX_REASON,
      ),
      priority: IMPACT.rejectedRewrite + recencyBonus(roles, bullet.roleId),
    });
  }

  // ---- 2. what the evidence grader called thin --------------------------------
  for (const weak of signal.weakBullets) {
    if (weak.sectionKey !== 'experience' && weak.sectionKey !== 'projects') continue;
    const recordId = recordIdForText(signal.document, weak.text);
    if (!recordId) continue;
    const record = recordById.get(recordId);
    if (!record) continue;

    const parts = deficienciesFrom(weak.problem);
    // The grader's own sentence, verbatim. A paraphrase here would be this module
    // guessing at a judgement it did not make.
    const reason = clip(`The evidence grader flagged this one: ${weak.problem}`, MAX_REASON);

    if (record.type === 'experience-bullet') {
      if (missingBulletParts(record).length === 0) continue;
      const bullet = record as Extract<ProfileRecord, { type: 'experience-bullet' }>;
      put({
        subjectKey: `bullet:${record.id}`,
        kind: 'bullet',
        recordId: record.id,
        topic: '',
        quote: clip(bullet.text, MAX_QUOTE),
        context: roleLabel(roles, bullet.roleId),
        reason,
        priority:
          (parts.length > 1 ? IMPACT.weakBoth : IMPACT.weakOne) +
          recencyBonus(roles, bullet.roleId),
      });
    } else if (record.type === 'project') {
      const project = record as Extract<ProfileRecord, { type: 'project' }>;
      if (hasMeasurableOutcome(project.impactMetrics ?? [])) continue;
      put({
        subjectKey: `project:${record.id}`,
        kind: 'project',
        recordId: record.id,
        topic: '',
        quote: clip(project.name, MAX_QUOTE),
        context: clip(project.stack.slice(0, 4).join(', '), 120),
        reason,
        priority: IMPACT.projectNoOutcome,
      });
    }
  }

  // ---- 3. keywords the posting demands and the profile cannot back -------------
  /*
   * The posting's own title and employer are not skills, and asking about them is how a
   * good queue earns a reputation as a stupid one.
   *
   * `extractJobRequirement` puts them in `atsKeywords` — a real run produced "Technical
   * SEO Lead", "Semrush", "Remote" and "India" alongside "Screaming Frog" — and
   * `scoreSkillsCompleteness` correctly reports them as genuine gaps, because the
   * profile cannot evidence them. That is right for the halt message, which is telling
   * the user what the posting asked for. It is wrong for a question, which is asking
   * them to attest to having a skill: nobody "has" Semrush, and a question that cannot
   * be answered honestly teaches people to skip the ones that can.
   *
   * Filtered here rather than upstream on purpose. The scorer's notion of a gap is
   * load-bearing for the score and the halt explanation, and narrowing it would change
   * both to fix a wording problem that belongs to this module.
   */
  const notASkill = new Set(
    [signal.job?.roleTitle, signal.job?.company]
      .filter((v): v is string => Boolean(v && v.trim()))
      .map((v) => v.toLowerCase().trim()),
  );

  for (const gap of signal.genuineGaps) {
    const keyword = canonicalSkillName(gap).trim();
    if (!keyword) continue;
    if (notASkill.has(keyword.toLowerCase())) continue;
    put({
      subjectKey: `skill:${keyword.toLowerCase()}`,
      kind: 'skill',
      recordId: null,
      topic: keyword,
      quote: keyword,
      context: signal.job?.roleTitle ?? '',
      reason: clip(
        `${
          signal.job?.roleTitle ? `The ${signal.job.roleTitle} posting` : 'The posting'
        } asks for ${keyword}, and nothing in your profile evidences it. No rewrite can close that honestly.`,
        MAX_REASON,
      ),
      priority: IMPACT.skillGap + keywordDemandBonus(signal.job, gap),
    });
  }

  // Qualified here rather than by the caller, so no producer above can add a question
  // that could not change a draft however strong its signal looked. `timesAsked` is not
  // available at intake and is not needed: a question this draft derived for the first
  // time has by definition not been ignored yet.
  return qualifyQuestions(orderQuestions([...byKey.values()]), {
    records,
    job: signal.job,
  });
}

/* ------------------------------------------- whether a question earns its place -- */

/**
 * How many drafts may re-derive one question before it stops being shown.
 *
 * Every draft that hits the same gap refreshes the row rather than duplicating it
 * (lib/server/enrichment.ts), so the refresh count is exactly "how many times we put this
 * in front of you and you did neither thing". Three is the point at which the honest
 * reading stops being "they have not got round to it" and becomes "they are not going to
 * answer this one" — and a queue whose top item never changes is a queue people stop
 * looking at, which costs the questions they WOULD have answered.
 *
 * Not a tombstone: the row stays open and keeps being counted, so nothing is thrown away
 * and a record that changes can bring its question back.
 */
export const MAX_TIMES_ASKED = 3;

/**
 * What is needed to judge whether answering a question could change anything.
 *
 * `job` is the posting being drafted for — at intake that is the draft that produced the
 * signal, and on /profile it is the most recent one. Null means no draft has happened, and
 * the retrieval test is then skipped rather than guessed: a question about a record no
 * posting has been matched against is not disqualified, it is simply unjudged.
 */
export interface QuestionAudience {
  records: ProfileRecord[];
  job: JobRequirement | null;
  /** How many drafts have re-asked this subject. Absent where it is not recorded. */
  timesAsked?: (subjectKey: string) => number;
}

/**
 * The records a resume for this job would actually be built from.
 *
 * The same two calls the pipeline makes — `rankRecords` then `selectTop` — so a question
 * qualifies on exactly the decision the draft makes rather than on a second opinion about
 * it. This is the test the owner's complaint is really about: a bullet the relevance floor
 * drops for the posting in hand cannot be improved into a better resume however much scale
 * the user types into it, so asking spends the only thing this queue has — their
 * willingness to answer the next one.
 */
export function reachableRecordIds(records: ProfileRecord[], job: JobRequirement): Set<string> {
  const live = records.filter((r) => !r.flaggedForRemoval);
  const { ranked } = rankRecords(live, job);
  return new Set(selectTop(ranked, DEFAULT_CAPS).map((r) => r.id));
}

/**
 * Whether a keyword is a thing a person can be asked whether they have.
 *
 * `scoreSkillsCompleteness` reports everything the posting names and the profile cannot
 * evidence, which is right for the score and wrong for a question: a real run against a
 * Technical SEO posting listed "Remote", "India" and "Technical SEO Lead" as genuine gaps.
 * The role title and employer are already filtered by name in `buildEnrichmentQuestions`;
 * this is the general form of the same rule, and it catches the ones that are not the
 * title — a location, a contract type, a seniority word.
 *
 * Two ways to pass. The deterministic classifier places it as a skill (./record-type.ts,
 * which is also what stops "AWS Certified Solutions Architect" being asked as one), or the
 * posting itself calls it a required skill — the posting asserting it is one, and the only
 * thing that lets a tool no dictionary has heard of still be asked about.
 */
export function isAskableSkill(topic: string, job: JobRequirement | null): boolean {
  const name = (topic ?? '').trim();
  if (!name) return false;
  if (classifyRecordType({ name }).type === 'skill') return true;
  const key = name.toLowerCase();
  return Boolean(job?.requiredSkills.some((s) => s.toLowerCase().trim() === key));
}

/**
 * Whether answering this could move a score, with the reason when it could not.
 *
 * Three tests, each one a decision the pipeline already makes somewhere else:
 *
 *   reach      the record survives retrieval for this job (`reachableRecordIds`), or the
 *              keyword is one the posting states. Nothing else reaches a draft at all.
 *   read       the missing piece is one a scorer grades. `isGapOpen` is that test and it
 *              stays the caller's, so all that is added here is the skill-shape rule that
 *              stops the queue asking whether you "have" a location.
 *   patience   it has not been re-asked past `MAX_TIMES_ASKED`.
 *
 * The reason string is not shown to the user — it is for the probes and the tests, because
 * "the new code asks four where the old asked nineteen" is only believable alongside which
 * rule removed each of the fifteen.
 */
export function questionQualifies(
  question: { kind: QuestionKind; recordId: string | null; topic: string; subjectKey: string },
  audience: QuestionAudience,
  reachable?: Set<string>,
): { ok: boolean; why: string } {
  const asked = audience.timesAsked?.(question.subjectKey) ?? 0;
  if (asked >= MAX_TIMES_ASKED) {
    return { ok: false, why: `asked ${asked} times and still open` };
  }

  if (question.kind === 'skill') {
    return isAskableSkill(question.topic, audience.job)
      ? { ok: true, why: 'the posting asks for a skill the profile cannot evidence' }
      : { ok: false, why: `"${question.topic}" is not a skill anyone can claim to have` };
  }

  if (!audience.job) return { ok: true, why: 'no posting to judge reach against yet' };

  const reach = reachable ?? reachableRecordIds(audience.records, audience.job);
  if (!question.recordId || !reach.has(question.recordId)) {
    return { ok: false, why: 'retrieval would not put this record on a resume for this job' };
  }
  return { ok: true, why: 'the record reaches the resume and the scorer grades what is missing' };
}

/** The questions that qualify. Retrieval is ranked once for the whole list. */
export function qualifyQuestions<
  T extends { kind: QuestionKind; recordId: string | null; topic: string; subjectKey: string },
>(questions: T[], audience: QuestionAudience): T[] {
  const needsReach = questions.some((q) => q.kind !== 'skill');
  const reachable =
    needsReach && audience.job ? reachableRecordIds(audience.records, audience.job) : undefined;
  return questions.filter((q) => questionQualifies(q, audience, reachable).ok);
}

/**
 * Highest impact first, then by subject so the list is stable.
 *
 * Stability matters more than it sounds: this queue is re-read on every /profile load,
 * and a list that reorders itself between two renders of the same data is one where the
 * question you were half-way through answering moves under the cursor.
 */
export function orderQuestions<T extends { priority: number; subjectKey: string }>(
  questions: T[],
): T[] {
  return [...questions].sort(
    (a, b) => b.priority - a.priority || a.subjectKey.localeCompare(b.subjectKey),
  );
}

/**
 * The best `limit` questions, with no single kind of signal allowed to be all of them.
 *
 * Measured, not guessed. The first real run of this — a thin profile against a Technical
 * SEO posting — produced fifteen genuine keyword gaps, one refused rewrite, one weak
 * bullet and an evidence sub-score of zero. Because a keyword gap outranks everything
 * (correctly: it is the heaviest sub-score and the documented halt reason), a plain
 * `slice` gave six keyword gaps and then, on the page, three. The queue read "have you
 * used Sitebulb?" three times, never once quoted a line the user had written, and could
 * not have moved the evidence score by a point however many were answered.
 *
 * So: one pass rationing each kind to half the allowance, then a second filling whatever
 * is left from the best of the remainder. Ordering still decides what is most valuable
 * and the top item is still the top item; this only stops the most valuable KIND from
 * being the only kind. When a draft genuinely found one kind of problem, the second pass
 * hands it the whole allowance anyway, so this is a share of a contested budget rather
 * than a quota.
 *
 * Used for both the intake cap and the on-screen cap, because the failure is identical
 * at both sizes and two rules that must agree eventually will not.
 */
export function rationedSlice<T extends { kind: QuestionKind; subjectKey: string; priority: number }>(
  questions: T[],
  limit: number,
): T[] {
  if (limit <= 0) return [];
  const ordered = orderQuestions(questions);
  const ration = rationPerKind(limit);

  const chosen: T[] = [];
  const perKind = new Map<QuestionKind, number>();

  for (const q of ordered) {
    if (chosen.length >= limit) break;
    const used = perKind.get(q.kind) ?? 0;
    if (used >= ration) continue;
    perKind.set(q.kind, used + 1);
    chosen.push(q);
  }

  const taken = new Set(chosen.map((q) => q.subjectKey));
  for (const q of ordered) {
    if (chosen.length >= limit) break;
    if (taken.has(q.subjectKey)) continue;
    chosen.push(q);
  }

  return orderQuestions(chosen);
}

/**
 * What actually gets written, given what is already queued.
 *
 * Settled questions count as taken: a subject that was answered or skipped is never
 * asked again, which is the rule a rejected sync proposal already follows and for the
 * same reason — a queue that refills with things you have dealt with is one you stop
 * reading.
 */
export function selectNewQuestions(
  drafted: DraftedQuestion[],
  existingSubjectKeys: Iterable<string>,
  openCount: number,
): DraftedQuestion[] {
  const taken = new Set(existingSubjectKeys);
  const room = Math.min(
    MAX_NEW_QUESTIONS_PER_DRAFT,
    Math.max(0, MAX_OPEN_QUESTIONS - openCount),
  );
  if (room === 0) return [];

  return rationedSlice(
    drafted.filter((q) => !taken.has(q.subjectKey)),
    room,
  );
}
