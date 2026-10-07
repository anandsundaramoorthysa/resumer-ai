/**
 * Consent record and invite codes. Verified against scripts/2026-10-07-consent-invites.sql.
 */

import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './schema';

/** One row per (user, policy version) the user accepted: provable, versioned consent. */
export const userConsent = pgTable(
  'user_consent',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    policyVersion: text('policy_version').notNull(),
    termsVersion: text('terms_version').notNull(),
    ageAttested: boolean('age_attested').notNull(),
    acceptedAt: timestamp('accepted_at').defaultNow().notNull(),
    /** signup | oauth-consent-page */
    source: text('source').notNull(),
  },
  (t) => [uniqueIndex('user_consent_user_version_idx').on(t.userId, t.policyVersion)],
);

/** Only the SHA-256 of a code is stored; the plaintext is shown once, at creation. */
export const inviteCodes = pgTable('invite_code', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  codeHash: text('code_hash').notNull().unique(),
  label: text('label').notNull().default(''),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  maxUses: integer('max_uses').notNull().default(1),
  uses: integer('uses').notNull().default(0),
  expiresAt: timestamp('expires_at'),
  disabled: boolean('disabled').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * One row per auto-approved account (user_id unique: an account redeems at most once; set to NULL when the account is deleted, the row staying as a quota tombstone).
 * invite_id is null for approvals made by SIGNUP_MODE=open, which uses no code.
 */
export const inviteRedemptions = pgTable(
  'invite_redemption',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    inviteId: text('invite_id').references(() => inviteCodes.id, { onDelete: 'cascade' }),
    // Nullable + SET NULL: deleting the account keeps the row as a tombstone, so the
    // IST-day quota (counted by redeemed_at) cannot be reset by signup -> approve -> delete.
    // UNIQUE still holds per live user (Postgres allows many NULLs).
    userId: text('user_id')
      .unique()
      .references(() => users.id, { onDelete: 'set null' }),
    redeemedAt: timestamp('redeemed_at').defaultNow().notNull(),
  },
  (t) => [index('invite_redemption_invite_idx').on(t.inviteId), index('invite_redemption_at_idx').on(t.redeemedAt)],
);
