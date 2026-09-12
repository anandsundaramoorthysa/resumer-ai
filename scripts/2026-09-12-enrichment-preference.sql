-- Questions that can be turned off, and questions that stop asking on their own.
--
-- APPLIED to production 2026-09-12, by hand:
--   psql "$DATABASE_URL" -f scripts/2026-09-12-enrichment-preference.sql
-- Both objects are declared in lib/db/schema.ts. The code no longer tolerates their
-- absence, so a fresh database needs this (or `npm run db:push`) before /profile renders.
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
