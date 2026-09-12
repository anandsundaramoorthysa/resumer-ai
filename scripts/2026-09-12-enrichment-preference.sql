-- Questions that can be turned off, and questions that stop asking on their own.
--
-- NOT APPLIED. Production DDL is not run from an agent session — apply this by hand:
--   psql "$DATABASE_URL" -f scripts/2026-09-12-enrichment-preference.sql
-- or let `npm run db:push` pick up `enrichmentPreferences` in lib/db/schema.ts (which does
-- NOT cover the asked_count column below — that one is only here).
--
-- The code ships ahead of this migration and works without it:
--   * `loadEnrichmentMode` catches the missing relation and reads it as the default `all`,
--     so /profile renders and every user keeps the behaviour they have today.
--   * `askedCounts` / `countAsked` catch the missing column and return no counts, so the
--     "asked three times and still open" test simply never fires.
-- Both catches are marked in lib/server/enrichment.ts and should be deleted once this has
-- run, along with moving asked_count into lib/db/schema.ts — a swallowed error that has
-- stopped being possible is a swallowed error nobody will remember is there.
--
-- Safe to re-run, and nothing here touches an existing row's meaning: the new table starts
-- empty (empty == `all`) and the new column starts at 0 (0 == never re-asked), so applying
-- it changes no user's queue on the day it runs.

begin;

-- How much this person wants to be asked: all | current-job | off.
-- One row per user, written only when they change it from the default.
create table if not exists enrichment_preference (
  user_id    text primary key references "user"(id) on delete cascade,
  mode       text        not null default 'all',
  updated_at timestamp   not null default now()
);

-- How many drafts have re-derived this question without it being answered or dismissed.
-- Bumped by recordEnrichmentQuestions on every draft that finds the same gap again; past
-- MAX_TIMES_ASKED (lib/profile/enrichment.ts) the row stays open but stops being shown.
alter table enrichment_question
  add column if not exists asked_count integer not null default 0;

commit;
