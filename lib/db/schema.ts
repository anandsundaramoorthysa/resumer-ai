/**
 * Database schema — specs/design.md §3.
 *
 * NFR-6: every table carries userId from day one, even while single-user, so opening
 * this up later is a policy change rather than a migration.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AdapterAccountType } from 'next-auth/adapters';

/* ------------------------------------------------------------------ auth ---- */

export const users = pgTable('user', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  /**
   * Set only for accounts created with a password. Null means this user signs in with
   * GitHub or Google, and a password sign-in attempt against them must fail exactly as
   * a wrong password does — a distinguishable failure tells a stranger which addresses
   * have OAuth accounts.
   */
  passwordHash: text('password_hash'),
  /**
   * The cut-off for sessions. A JWT minted before this instant is refused by the
   * `session` callback in auth.ts, which is what makes a password reset actually end
   * the sessions that existed before it — stateless tokens otherwise keep working for
   * their full lifetime, so someone who resets *because* they think they are
   * compromised stays compromised.
   *
   * Null is not "invalidate everything", it is "no reset has ever happened here", so
   * shipping the column does not sign every existing user out.
   */
  sessionsValidFrom: timestamp('sessions_valid_from'),
  image: text('image'),
  githubLogin: text('github_login'),
  /** REQ-2.2 — last portfolio commit SHA we parsed, the sync gate's cache key. */
  lastSyncedSha: text('last_synced_sha'),
  lastSyncedAt: timestamp('last_synced_at'),
  portfolioRepo: text('portfolio_repo'), // "owner/name"
  /**
   * pending | approved | denied — whether the owner has let this account use the app.
   *
   * Sign-up is open, and every account spends the owner's AI keys, so a new account waits
   * for the owner's decision (lib/server/approval.ts). Defaults to `pending` for every row
   * written from now on; the migration that added it marked the accounts that already
   * existed `approved`. The owner's own accounts are approved whatever this says.
   */
  approval: text('approval').notNull().default('pending'),
  approvalDecidedAt: timestamp('approval_decided_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const accounts = pgTable(
  'account',
  {
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('providerAccountId').notNull(),
    /** REQ-2.1 — the GitHub token from the same sign-in that authenticated the user. */
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable('session', {
  sessionToken: text('sessionToken').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
});

export const verificationTokens = pgTable(
  'verificationToken',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

/**
 * A GitHub App installation, which is how repository access is granted.
 *
 * Distinct from the `account` row, which holds the OAuth identity. That distinction is
 * the point of moving to a GitHub App: signing in proves who someone is, installing
 * grants read access to the repositories they choose, and the two are no longer the same
 * grant. Nothing here is a credential — an installation id is a public-ish identifier,
 * and the token that reads a repository is minted from the app's private key on demand
 * and never stored.
 *
 * One user may have several: a personal account and an organisation are separate
 * installations, and a portfolio can live in either.
 */
export const githubInstallations = pgTable(
  'github_installation',
  {
    /** GitHub's own installation id. */
    id: integer('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The user or organisation the app is installed on. */
    accountLogin: text('account_login').notNull(),
    targetType: text('target_type').notNull(), // User | Organization
    repositorySelection: text('repository_selection').notNull(), // all | selected
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /** Set when GitHub tells us the installation was removed or suspended. */
    removedAt: timestamp('removed_at'),
  },
  (t) => [index('github_installation_user_idx').on(t.userId)],
);

/**
 * Single-use tokens for email verification and password reset.
 *
 * Separate from `verificationToken`, which belongs to the Auth.js adapter and has its
 * own lifecycle. Only a hash of the token is stored: the database is the thing most
 * likely to leak, and a stored plaintext reset token is a password reset for anyone who
 * reads it. `usedAt` makes a link single-use even before it expires.
 */
export const authTokens = pgTable(
  'auth_token',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** The email address, normalised. Not a userId: a reset must work before sign-in. */
    identifier: text('identifier').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    purpose: text('purpose').notNull(), // verify-email | reset-password
    expires: timestamp('expires', { mode: 'date' }).notNull(),
    usedAt: timestamp('used_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('auth_token_identifier_idx').on(t.identifier, t.purpose)],
);

/**
 * Rate-limit counters.
 *
 * In the database rather than in memory because every request may run in a different
 * function instance — an in-process counter on a serverless host limits one instance
 * and lets an attacker walk straight past it.
 */
export const authAttempts = pgTable(
  'auth_attempt',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** What is being limited: an email address, or an IP address. */
    subject: text('subject').notNull(),
    action: text('action').notNull(), // sign-in | sign-up | reset-request | verify
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('auth_attempt_idx').on(t.subject, t.action, t.createdAt)],
);

/* --------------------------------------------------------------- profile ---- */

/** Contact block rendered into the document body (REQ-6.1). */
export const contactInfo = pgTable('contact_info', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull().default(''),
  email: text('email').notNull().default(''),
  phone: text('phone'),
  location: text('location'),
  portfolioUrl: text('portfolio_url'),
  githubUrl: text('github_url'),
  linkedinUrl: text('linkedin_url'),
});

export const roles = pgTable(
  'role',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    startDate: text('start_date').notNull(), // 'YYYY-MM'
    endDate: text('end_date').notNull().default('present'),
    source: text('source').notNull().default('manual'),
    contentHash: text('content_hash').notNull(),
    /** approved | pending | rejected — see profile_record.review_state. */
    reviewState: text('review_state').notNull().default('approved'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('role_user_idx').on(t.userId)],
);

/**
 * All atomic profile facts in one table, discriminated by `type` (REQ-1.1).
 * Type-specific fields live in `data` so adding a record type is not a migration.
 */
export const profileRecords = pgTable(
  'profile_record',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // skill | experience-bullet | project | education | certification | achievement
    /** REQ-1.2 — provenance. Sync may never touch a 'manual' record. */
    source: text('source').notNull().default('manual'),
    contentHash: text('content_hash').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    /** REQ-2.4 — flagged for review, never silently deleted. */
    flaggedForRemoval: boolean('flagged_for_removal').notNull().default(false),
    /**
     * Whether this record counts as part of the profile yet.
     *
     *   approved  in the profile; every draft is built and verified against it
     *   pending   a sync proposed it and the user has not yet accepted it
     *   rejected  the user said no; kept as a tombstone so sync stops re-proposing it
     *
     * The default is `approved` on purpose. Everything the user typed, imported or
     * already had is approved by definition, so the column arrives without a backfill
     * and no existing profile changes. Only `lib/server/profile.ts` writes `pending`,
     * and only for a github-sync record that is new — see lib/sync/reconcile.ts for
     * the rule and why updates are exempt from it.
     */
    reviewState: text('review_state').notNull().default('approved'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('record_user_type_idx').on(t.userId, t.type),
    uniqueIndex('record_user_hash_idx').on(t.userId, t.contentHash),
  ],
);

/**
 * Questions a draft could not answer for itself — the enrichment queue.
 *
 * Every row is a deficiency the pipeline measured against one specific record and could
 * not close without inventing something: a refused grounded rewrite, a bullet the
 * evidence grader called thin, or a keyword the posting demands that the profile cannot
 * back. The reasoning is in lib/profile/enrichment.ts; this is only where it is kept.
 *
 * Three columns carry the whole policy:
 *
 *   `subject_key`  one open question per subject, not per complaint. Unique with
 *                  user_id, which is what stops the next draft queuing the same gap
 *                  again — the same job `content_hash` does for a profile record.
 *   `state`        open | answered | dismissed. A settled question is a tombstone, not
 *                  a deletion, for the reason lib/server/sync-review.ts gives about
 *                  rejected proposals: a queue that refills with things you already
 *                  decided is one you stop reading.
 *   `record_id`    the record the answer is written into, with the delete cascading.
 *                  A question about a fact that no longer exists is noise.
 *
 * Nothing here is a claim: a question is the absence of one. That is why the table sits
 * outside `profile_record` and why `loadProfileForUser` neither knows nor cares about it.
 */
export const enrichmentQuestions = pgTable(
  'enrichment_question',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Null for a skill gap, which is about the profile as a whole, not one row. */
    recordId: text('record_id').references(() => profileRecords.id, {
      onDelete: 'cascade',
    }),
    /** bullet:<recordId> | project:<recordId> | skill:<keyword> */
    subjectKey: text('subject_key').notNull(),
    kind: text('kind').notNull(), // bullet | project | skill
    /** The keyword, for a skill question. Empty otherwise. */
    topic: text('topic').notNull().default(''),
    /** The user's own words the question is about — never generated text. */
    quote: text('quote').notNull().default(''),
    /** Where those words live: "Engineer — Acme", a project's stack, the posting. */
    context: text('context').notNull().default(''),
    /** The signal's own account of what is absent, verbatim. */
    reason: text('reason').notNull().default(''),
    /** Impact, highest first — see IMPACT in lib/profile/enrichment.ts. */
    priority: integer('priority').notNull().default(0),
    state: text('state').notNull().default('open'), // open | answered | dismissed
    /** What the answer became, so a fact can be traced back to the question. */
    answerRecordId: text('answer_record_id'),
    /** The answer in the user's own words, kept whether or not a record stored it. */
    answer: text('answer').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    settledAt: timestamp('settled_at'),
  },
  (t) => [
    index('enrichment_user_state_idx').on(t.userId, t.state),
    uniqueIndex('enrichment_user_subject_idx').on(t.userId, t.subjectKey),
  ],
);

/**
 * Whether this person wants to be asked draft questions at all — REQ-5.5's off switch.
 *
 * The enrichment queue was unconditional: every draft added to it and /profile always
 * showed the top of it. The owner's complaint was not that the questions were wrong but
 * that there was no way to stop them, and a prompt you cannot turn off is one you learn to
 * scroll past — which costs the questions you would otherwise have answered.
 *
 * One row per person, written only when they change it. Absent means `all`, so the table
 * being empty and the table not existing yet are the same answer: see
 * `loadEnrichmentMode` in lib/server/enrichment.ts, which treats a missing relation as the
 * default rather than an error. That is deliberate — this table ships before its migration
 * is applied to production.
 *
 * Per-question refusal is NOT here. That has always been `enrichment_question.state =
 * 'dismissed'`, a tombstone the unique index on (user_id, subject_key) makes permanent.
 */
export const enrichmentPreferences = pgTable('enrichment_preference', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** all | current-job | off — see ENRICHMENT_MODES in lib/server/enrichment.ts. */
  mode: text('mode').notNull().default('all'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/** REQ-1.3 — reserved for Phase 10 autofill. Nothing reads these yet. */
export const applicationFormFields = pgTable('application_form_fields', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  workAuthorization: text('work_authorization'),
  visaSponsorshipNeeded: boolean('visa_sponsorship_needed'),
  eeoAnswers: jsonb('eeo_answers').$type<Record<string, string>>(),
  salaryExpectation: text('salary_expectation'),
  noticePeriod: text('notice_period'),
});

/* --------------------------------------------------------------- resumes ---- */

/** REQ-9.2 — immutable snapshot of exactly what was sent. */
export const resumeSnapshots = pgTable(
  'resume_snapshot',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    jobRequirement: jsonb('job_requirement').$type<Record<string, unknown> | null>(),
    score: real('score'),
    scoreDetail: jsonb('score_detail').$type<Record<string, unknown>>(),
    recordHashSnapshot: jsonb('record_hash_snapshot').$type<string[]>().notNull().default([]),
    renderMode: text('render_mode').notNull().default('ats-strict'),
    fileName: text('file_name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('snapshot_user_idx').on(t.userId)],
);

/** Module 9 — application tracker. */
export const applications = pgTable(
  'application',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resumeSnapshotId: text('resume_snapshot_id')
      .notNull()
      .references(() => resumeSnapshots.id, { onDelete: 'cascade' }),
    roleTitle: text('role_title').notNull(),
    company: text('company').notNull().default(''),
    category: text('category').notNull().default('general'),
    score: real('score'),
    status: text('status').notNull().default('draft'),
    appliedAt: timestamp('applied_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('application_user_idx').on(t.userId)],
);

/* ------------------------------------------------------------ ops / audit ---- */

/** REQ-10.1 — audit trail on every profile mutation. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recordId: text('record_id'),
    action: text('action').notNull(), // create | update | flag-removed | delete
    source: text('source').notNull(), // manual | github-sync | ai-import
    diff: jsonb('diff').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('audit_user_idx').on(t.userId, t.createdAt)],
);

/** REQ-5.6 / NFR-2 — daily spend ceiling, persisted across requests. */
export const aiUsageDaily = pgTable(
  'ai_usage_daily',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: text('day').notNull(), // 'YYYY-MM-DD' UTC
    calls: integer('calls').notNull().default(0),
    tokens: integer('tokens').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/**
 * One row per draft attempt — successful or not.
 *
 * WHAT THE ABSENCE OF THIS TABLE COST. Resume drafting was broken in production for the
 * entire life of the deployment and nothing noticed: the owner's account had zero
 * snapshots, ever. Six separate faults were behind it — a 30-second function limit
 * against a 50-second budget, a schema cap that discarded the only provider that
 * answered, a stream that died silently, an overloaded provider retried instead of
 * skipped, a PDF reader missing its native binary and its worker. Every one was found by
 * hand, with a throwaway account and a live log stream, because a failed draft left
 * behind exactly two things: a counter increment in `ai_usage_daily` and one
 * `console.error` line in a function log that rolls over. A successful draft persisted a
 * `resume_snapshot`; a failed one persisted nothing, so "how often does drafting work"
 * was a question the system could not answer about itself.
 *
 * So: written on every run, from app/api/draft/route.ts, which is the one place that sees
 * both the event stream and the outcome. Three things are kept that existed only in
 * flight before:
 *
 *   `stages`      the per-stage timeline the SSE stream sends to the browser and then
 *                 forgets. Status, message and elapsed ms per event — which is what turns
 *                 "the draft failed" into "understand took 41s and then finalize threw".
 *   `error_*`     the developer-facing failure, which previously reached only the log.
 *                 NEVER relayed to the browser: app/api/draft/route.ts explains why at
 *                 length, and storing it for the owner does not change that rule.
 *   `rewrite_*`   whether the grounded rewrite actually ran. A draft where every bullet
 *                 fell back to the user's own words looks identical, in the document and
 *                 in the snapshot, to one where the model did the work.
 *
 * Bounded per user — see RUNS_KEPT_PER_USER in lib/server/draft-run.ts for the
 * number and the reasoning. This is a free Postgres tier and a diagnostic log is exactly
 * the kind of table that quietly eats it.
 */
export const draftRuns = pgTable(
  'draft_run',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at').notNull(),
    finishedAt: timestamp('finished_at').defaultNow().notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    /** success | failed */
    status: text('status').notNull(),
    /** The job as the pipeline understood it. Empty when it failed before understanding. */
    roleTitle: text('role_title').notNull().default(''),
    company: text('company').notNull().default(''),
    /**
     * The snapshot this run produced, when it produced one.
     *
     * `set null` rather than `cascade`: deleting a resume must not delete the evidence
     * that drafting it worked. The run outlives its output.
     */
    snapshotId: text('snapshot_id').references(() => resumeSnapshots.id, {
      onDelete: 'set null',
    }),
    score: real('score'),
    keywordCoveragePct: real('keyword_coverage_pct'),
    /** iteration-cap | budget-cap | unfixable-gap | no-progress — see QualityGateResult. */
    haltReason: text('halt_reason'),
    /** [{ stage, status, message, elapsedMs }] in emission order. */
    stages: jsonb('stages')
      .$type<Array<{ stage: string; status: string; message: string; elapsedMs: number }>>()
      .notNull()
      .default([]),
    /** What this run actually spent, counted on the failure path too. */
    budgetCalls: integer('budget_calls').notNull().default(0),
    budgetTokens: integer('budget_tokens').notNull().default(0),
    /** Bullets the grounded rewrite was asked to improve. */
    rewriteAttempted: integer('rewrite_attempted').notNull().default(0),
    /** Of those, how many were printed in the user's own words instead. */
    rewriteFallbacks: integer('rewrite_fallbacks').notNull().default(0),
    /** none | grounding | call-failed — the two are not the same finding. */
    rewriteFallbackReason: text('rewrite_fallback_reason').notNull().default('none'),
    /** A stable slug, so failures can be counted by cause: `all-providers-failed`. */
    errorKind: text('error_kind'),
    /** Developer-facing, redacted and truncated. Owner-visible only, never streamed. */
    errorDetail: text('error_detail'),
  },
  (t) => [index('draft_run_user_idx').on(t.userId, t.startedAt)],
);

/**
 * Sync jobs — REQ-2.2/2.3 executed across multiple short requests.
 *
 * Portfolio extraction measured 1-3 minutes, which no serverless function tolerates
 * (Netlify caps at 60s, Vercel at 300s). Rather than race a limit, the work is split
 * into steps that each run in one short request, with progress kept here so the client
 * can drive it and show honest progress. Also survives a page refresh mid-sync.
 */
export const syncJobs = pgTable(
  'sync_job',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'), // running | done | error
    step: integer('step').notNull().default(0),
    totalSteps: integer('total_steps').notNull().default(7),
    message: text('message').notNull().default('Starting…'),
    sha: text('sha'),
    /** Fetched corpus, carried between steps so it isn't re-downloaded each time. */
    corpus: jsonb('corpus').$type<Array<{ path: string; content: string }>>(),
    /** Accumulated extraction output, merged at the final step. */
    partials: jsonb('partials').$type<Record<string, unknown>[]>().notNull().default([]),
    error: text('error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('syncjob_user_idx').on(t.userId, t.createdAt)],
);

/**
 * Providers benched by a failure — lib/ai/chain.ts.
 *
 * The cooldown used to live only in a module-level Map, and on a serverless host that
 * memory dies with the instance: every cold invocation started with an empty map and
 * paid the full cost of the lesson again. Measured this week: `gemini-flash-latest` was
 * overloaded for hours, it is first in the routing order, and every single draft spent
 * 4-13 seconds being told "This model is currently experiencing high demand" before
 * falling through to a provider that answered in about three — out of a 20-second draft
 * budget, under a 30-second function limit. Here, one instance learning a provider is
 * down spares all the others.
 *
 * The one table with no userId, deliberately. NFR-6 is about user data being separable;
 * a provider's health is a property of the provider, and scoping it per user would mean
 * every user re-learning the same outage at their own expense.
 *
 * `until` is timestamptz, not a bare timestamp: a `timestamp without time zone` is
 * written as a UTC wall clock and read back as a local one, so on a machine at +05:30
 * every cooldown would come back either five hours long or already expired. The whole
 * value of this row is an instant two minutes from now being right.
 */
export const aiProviderCooldown = pgTable('ai_provider_cooldown', {
  /** A ProviderId from lib/ai/models.ts — 'google', 'groq', … */
  providerId: text('provider_id').primaryKey(),
  until: timestamp('until', { withTimezone: true }).notNull(),
  reason: text('reason').notNull(), // quota | overload | slow
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Suggestions the owner dismissed — lib/server/steward.ts.
 *
 * Keyed by the suggestion's fingerprint, which folds in the content hash of every record
 * it concerns (lib/steward/types.ts). So a dismissal is remembered exactly as long as the
 * record stays as it was: edit the record and the steward may judge it again, which is
 * the point — the old "no" was about the old words.
 *
 * Without this, every review re-proposed what the owner had already declined, and a
 * reviewer that nags gets ignored, which is worse than no reviewer.
 */
export const stewardDismissals = pgTable(
  'steward_dismissal',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    suggestionId: text('suggestion_id').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.suggestionId] })],
);

/**
 * What kind of thing a skill name is — the shared answer, cached once for everyone.
 *
 * The dictionary and shape rules in lib/skills/categories.ts place the skills the world
 * shares; this holds what a model was asked about the rest (lib/skills/classify-ai.ts).
 * A skill name is professional vocabulary rather than anything about a person, so the row
 * carries no user id and nothing links it back to who listed it — which is also what makes
 * it worth caching: a name is asked about once, ever, not once per user who has it.
 */
export const skillCategoryCache = pgTable('skill_category', {
  /** The skill identity (lib/skills/identity.ts), so every spelling shares one row. */
  nameKey: text('name_key').primaryKey(),
  category: text('category').notNull(),
  /** ai — the deterministic layers never write here; they need no cache. */
  source: text('source').notNull().default('ai'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
