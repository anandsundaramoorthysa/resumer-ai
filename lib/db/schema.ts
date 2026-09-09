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
    embedding: jsonb('embedding').$type<number[] | null>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('record_user_type_idx').on(t.userId, t.type),
    uniqueIndex('record_user_hash_idx').on(t.userId, t.contentHash),
  ],
);

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
