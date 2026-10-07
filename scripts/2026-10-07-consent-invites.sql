-- Consent record + invite codes. Idempotent; apply by hand (db:push is not used in production).
CREATE TABLE IF NOT EXISTS "user_consent" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "policy_version" text NOT NULL,
  "terms_version" text NOT NULL,
  "age_attested" boolean NOT NULL,
  "accepted_at" timestamp DEFAULT now() NOT NULL,
  "source" text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_consent_user_version_idx" ON "user_consent" ("user_id", "policy_version");

CREATE TABLE IF NOT EXISTS "invite_code" (
  "id" text PRIMARY KEY NOT NULL,
  "code_hash" text NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "max_uses" integer DEFAULT 1 NOT NULL,
  "uses" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp,
  "disabled" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "invite_code_code_hash_unique" UNIQUE ("code_hash")
);

CREATE TABLE IF NOT EXISTS "invite_redemption" (
  "id" text PRIMARY KEY NOT NULL,
  "invite_id" text REFERENCES "invite_code"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "redeemed_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "invite_redemption_user_id_unique" UNIQUE ("user_id")
);
CREATE INDEX IF NOT EXISTS "invite_redemption_invite_idx" ON "invite_redemption" ("invite_id");
CREATE INDEX IF NOT EXISTS "invite_redemption_at_idx" ON "invite_redemption" ("redeemed_at");
