# Resumer AI

[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue?style=flat-square)](LICENSE)
[![Commercial license available](https://img.shields.io/badge/commercial-license%20available-success?style=flat-square)](COMMERCIAL-LICENSE.md)

One profile, every role. Resumer AI keeps a single professional profile in sync with your
portfolio, tailors an ATS-safe resume to any job posting, and scores and revises that
resume until it clears a quality bar — before you ever see it.

- **Plan and rationale:** [`PLAN.md`](./PLAN.md)
- **Specs:** [`specs/requirements.md`](./specs/requirements.md) · [`specs/design.md`](./specs/design.md) · [`specs/tasks.md`](./specs/tasks.md)

---

## What's in this release

Branch `feat/serpapi-job-radar` (not yet merged to `main`). On top of the base app
(commit `14fcb20`) it adds:

- **Job Radar** on SerpApi: planner, async search with a credit ledger, deterministic
  ranker, employer intel, market signal, two human gates, handoff to the tailor.
- **Reliability:** idempotent draft requests (`Idempotency-Key`, `/api/draft/status`,
  replay of a finished draft, salvage of a partly finished one, a reaper for dead runs),
  step leases and a poison-step guard on radar runs, AI provider circuit breaker and
  model-gone bench, per-attempt AI telemetry (`ai_call`).
- **Access and legal:** privacy, terms, contact, accessibility and consent pages with a
  recorded consent version and 18+ attestation, invite codes, `SIGNUP_MODE`, 7-day sessions.
  The legal text is placeholder-grade until counsel reviews it
  ([`docs/production/LEGAL-REVIEW.md`](./docs/production/LEGAL-REVIEW.md)).
- **Operations:** kill switches at `/admin/flags`, `/api/health`, structured logs, Sentry
  scrubbing, scheduled housekeeping with retention, heartbeats and alert emails, CI with a
  dependency audit and gitleaks, Dependabot.
- **Rendering:** embedded Noto fonts so the rupee sign and Devanagari and Tamil text render
  in PDFs.
- **UI:** the ink-on-paper redesign.

Honest limits you should know before you try it:

- **Node 22 is required.** The Vercel AI SDK (`ai`, `@ai-sdk/gateway`) declares `>=22`, so
  on Node 20 `npm install` reports `EBADENGINE`. `.nvmrc`, `netlify.toml` and
  `package.json` (`engines`) all pin it.
- **Free-tier AI capacity is small.** On Groq's free tier expect roughly 10-15 drafts a day.
- **SerpApi's free plan is 250 searches a month**, and a search that finds nothing is still billed.
- **Indic PDF text layer.** Devanagari and Tamil names render correctly, but the text layer
  of the PDF is in visual glyph order, so an ATS may misread them. Latin text is unaffected.

---

## Job Radar (SerpApi)

Job Radar finds openings for you instead of waiting for a pasted posting. It reads your
verified profile, plans a few Google Jobs searches, runs them through
[SerpApi](https://serpapi.com), ranks every posting against what your resume can actually
prove, adds employer and market context, and hands the posting you pick to the existing
grounded resume tailor.

- **Profile-grounded discovery.** A planner proposes 1-3 searches from your roles, skills
  and city (one fast model call; a rules-only plan from your role titles if the call fails).
  You can edit or remove them before any credit is spent.
- **Deterministic ranking.** Code scores each posting against your profile (skill lexicon
  plus the same keyword matcher the quality gate uses). No per-result model call, and it
  shows matched and missing skills per posting.
- **Employer intel.** For the top two companies: recent headlines via `google_news`, and a
  rating. `google_jobs_listing` returns nothing for most postings (checked live on
  2026-10-08), so the rating normally comes from a Google `reviews` search and is labelled
  `<Site> (via Google)`. A missing rating is shown as unknown, never guessed.
- **Market and salary signal.** Salary band (p25 / median / p75 in LPA, detected from SerpApi
  or estimated from the description and labelled as such), most-requested skills, and the
  ones you do not yet show.
- **Two human gates.** You approve the queries, then you pick the posting. Nothing is
  applied automatically; Apply opens the posting's own link in a new tab.
- **One-click handoff.** The chosen posting's text goes into the normal draft flow
  (fit check, grounded rewrite, critic loop), skipping URL scraping.

### SerpApi usage

| Engine | Parameters | Used for |
| --- | --- | --- |
| `google_jobs` | `q="<role> <city>"`, `gl=in`, `hl=en`, `google_domain=google.co.in`, `json_restrictor`, `async=true`; page 1 only | Posting discovery. Submitted async, then read back from the Search Archive |
| Search Archive (`/searches/<id>`) | `json_restrictor` (honoured) | Free reads of the async result |
| `google` | `q="<company> reviews"`, `gl=in`, `hl=en`, `google_domain=google.co.in` | Employer rating fallback, labelled `<Site> (via Google)` |
| `google_jobs_listing` | `q=<job_id>`, `gl=in`, `hl=en`, `google_domain=google.co.in` | Employer ratings when it has any (usually empty) |
| `google_news` | `q="<company>" company India` (quoted, results filtered to the company), `gl=in`, `hl=en` | Recent employer headlines |
| `account.json` | free endpoint | Guard: remaining monthly searches, memoized 5 min |

Verified live on 2026-10-08: an async submit returns `search_metadata.id` with status
`Processing` in about 300 ms, archive reads are free, and a search that returns no results
is still billed one credit (the app caches that empty answer for 10 minutes).

### Credit budgeting

SerpApi's free plan is 250 searches a month (and 50 an hour), so the radar is built to spend
very little:

- **Cache:** identical requests are served from the `serp_cache` table, 1 hour for jobs and
  24 hours for news, ratings and listings. Cache hits cost nothing.
- **Reserve before spend:** the credits for a call are reserved in SQL (`agent_run.credits_used`)
  and a ledger row is written before the HTTP call, so a killed or retried step cannot submit
  the same search twice and a failed run still counts against its caps.
- **Single flight:** identical concurrent searches share one upstream search.
- **Per-user limits:** 3 runs per day (the day resets at midnight IST) and at most 12 credits
  per run (a default run is roughly 4-7; employer intel reserves 3 per company and settles to
  what was billed).
- **Account guards:** searches are blocked when `account.json` reports fewer than 10 left, or
  when 45 live searches were stored in the past hour.
- **Replay fallback:** when blocked, or when no key is set, results come from the bundled
  fixtures, and the run shows a visible "showing sample data" banner. It never falls back
  silently. If the guard's own storage is down the answer is "temporarily unavailable", not
  fixtures.

### Modes

| `SERP_MODE` | Behaviour |
| --- | --- |
| `live` (or unset, with a key) | Real SerpApi calls through the cache and guards. |
| `replay` (or no `SERPAPI_API_KEY`) | Answers from `fixtures/serpapi/*.json`. **These fixtures are synthetic sample data, not live results**, and every replay run is labelled as such. |
| `record` | Live calls that also save each response into `fixtures/serpapi/`. Use it once to capture real data for a demo, then review the files before committing them. |

### Architecture

Netlify's free plan kills a function at 30 seconds, so a radar run is not one long request.
It is a state machine stored in Postgres (`agent_run`); the browser calls the API once per
step, each step does one short unit of work, and a refresh or a second tab resumes the same
run.

```
POST /api/radar ─► plan ─► [gate 1: approve queries] ─► search (async submit, parallel)
                                                          │
                                              poll (repeats; Search Archive reads)
                                                          │
          done ◄─ [gate 2: pick a posting] ◄─ intel ◄─ rank (+ market signal)
            │
            └─► draft console (grounded tailor, critic loop)
```

That is 7 steps (6 when employer intel is switched off). Every individual SerpApi HTTP call
is capped at 8 seconds and a poll step is a single bounded read, so no step comes near the
host's limit. Each step first claims a lease, then commits with
`UPDATE ... WHERE step = expectStep`, so two tabs cannot both advance a run, and a step that
keeps dying fails the run after 6 claims instead of looping. A search still pending 60 s after
submit is warned and skipped. A failed query or company is a warning and is skipped; only a
failed plan or every search failing ends the run in error. Details:
[`docs/hackathon/ARCHITECTURE.md`](./docs/hackathon/ARCHITECTURE.md).

### Privacy and security

- Only role, skill and city text is sent to SerpApi. Name, email, phone and links are not.
- `SERPAPI_API_KEY` is server-only (no `NEXT_PUBLIC_` variant), is never logged, and is
  scrubbed from every error string before it can reach the browser or Sentry.
- Every run is read and written under the signed-in user's id; another user's run looks
  like a missing one.
- Messages shown in the browser are authored by the app, never upstream error text.

The radar test suites are listed under [Verifying it works](#verifying-it-works).

### Judge quickstart (no keys)

Needs Node 22.

```bash
git clone <this repo> && cd resumer-ai
npm install
cp .env.example .env        # SERP_MODE=replay and RADAR_PUBLIC_DEMO=0 are the example values
npm run dev
```

Open <http://localhost:3000/radar?demo=1>. This is a public, scripted demo that runs in the
browser on sample data: the page does not read a session or the database, and needs no API
key. It is allowed whenever `NODE_ENV` is not `production` (so under `npm run dev`); a
production build needs `RADAR_PUBLIC_DEMO=1` (`app/radar/demo-gate.ts`). The rest of the app
(sign-in, drafts) needs the full setup below.

Without `AUTH_SECRET` the dev terminal prints one `[auth][error] MissingSecret` line on the first page load. The demo is
unaffected (checked on a fresh clone: `/` and `/radar?demo=1` return 200); set `AUTH_SECRET` (any random string) to silence it.

### Full setup (real accounts, real runs)

1. Postgres (`DATABASE_URL`), GitHub OAuth (`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`),
   `AUTH_SECRET`, `TOKEN_ENC_KEY`, and at least one AI provider key (see Setup below).
2. Create the tables: `npm run db:migrate` on a fresh database (see "Create tables" below for
   `db:baseline` on an existing one and the legacy SQL files).
3. Put your address in `OWNER_EMAILS` so your account is approved (see "Roles and sign-up").
4. Leave `SERPAPI_API_KEY` blank for replay on sample data, or set it with `SERP_MODE=live`
   for real searches. Then open `/radar`.

### Built for the SerpApi India Hackathon 2026

**What existed before the hackathon.** Resumer AI itself: profile import and sync, the
grounded resume tailor, the quality-gate loop, PDF/DOCX rendering, cover letters,
application tracker, auth and cost guardrails. That is the history up to commit `14fcb20`
(12 Sep 2026, 167 commits).

**What was built during the hackathon window.** Job Radar (SerpApi layer, cache and credit
budget, planner / ranker / market agents, stepped run orchestrator, `/radar` UI with approval
gates and handoff, tests) and the ink-on-paper UI redesign, starting from `14fcb20`.

**AI tools.** Built with Claude Code (Anthropic). At runtime the app calls Groq, Fireworks AI,
Together AI, DeepInfra and Gemini (whichever keys you configure) for planning, rewriting and
critique.

More: [`docs/hackathon/SUBMISSION.md`](./docs/hackathon/SUBMISSION.md) ·
[`docs/hackathon/ARCHITECTURE.md`](./docs/hackathon/ARCHITECTURE.md) ·
[`docs/hackathon/RADAR-PLAN.md`](./docs/hackathon/RADAR-PLAN.md) ·
[`docs/hackathon/UI-PLAN.md`](./docs/hackathon/UI-PLAN.md) ·
[`docs/hackathon/FINDINGS.md`](./docs/hackathon/FINDINGS.md)

### License

Resumer AI uses a **dual license**:

- **Noncommercial use is free** under the [PolyForm Noncommercial License 1.0.0](LICENSE) —
  use, modify, and share it for personal, research, educational, charitable, or government
  purposes at no cost.
- **Commercial use requires a paid commercial license.** See
  [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) or contact the author.

> Because it restricts commercial use, Resumer AI is **source-available**, not OSI-approved
> "open source." See the [LICENSE](LICENSE) file for the full terms.

---

## What makes it different

**It never invents anything.** Every generated bullet is checked against its source
record: any number or proper noun that appears in the rewrite but not in your actual
profile causes the rewrite to be rejected and your original wording kept. This is
enforced in code (`lib/generate/grounding.ts`), not just requested in a prompt.

**It scores itself before you see the output.** A keyword-coverage gate at 70%, then a
weighted score across formatting (30%), evidence quality (30%), and skills completeness
(40%). Below 8.5/10 it critiques itself, revises only the flagged parts, and re-scores —
up to 4 times. Three of the four checks are pure code, so they can't hallucinate.

**When it can't hit the bar, it says so.** If the job wants skills you genuinely don't
have, no rewrite can close that honestly — so it stops, shows the best version it made,
and tells you exactly what's capping the score instead of inventing experience.

**Getting your profile in doesn't start from scratch.** Upload an existing resume (PDF
or DOCX) at `/import` and it's read into the individual facts behind it — skills, roles,
bullets, projects, qualifications — and shown to you for approval. Nothing is stored
until you tick it, because these records are the only thing the generator is allowed to
say about you.

**The ATS rules are mechanical, not folklore.** Single column, no icons, contact details
in the document body (never a header/footer, which many parsers skip), spelled-out dates
(numeric ones parse differently by locale), plain bullet characters, and section headings
from an allow-list. Then every generated file is parsed *back* to text to confirm your
name, email, URLs and skills actually survive.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure

Copy `.env.example` to `.env` and fill in what's missing. The app shows you exactly
what's still needed when you load it, so you can do this one piece at a time.

| Variable | Needed for | Where to get it |
| --- | --- | --- |
| `DATABASE_URL` | Everything | Any Postgres. Free project at [neon.tech](https://neon.tech) is quickest. |
| `AUTH_SECRET` | Sign-in | `npx auth secret` |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | Sign-in + portfolio sync | [GitHub OAuth App](https://github.com/settings/developers), callback `http://localhost:3000/api/auth/callback/github` |
| `TOKEN_ENC_KEY` | Every draft, and stored tokens | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. The fit check in front of every draft is sealed with it. |
| At least one AI key | Generation | Fireworks, Groq, Together, DeepInfra, or Gemini |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google sign-in | Optional. [Google Cloud console](https://console.cloud.google.com/apis/credentials). |
| `SMTP_USER` / `SMTP_PASS` | Sign-up, password reset, alerts | A Gmail address and a 16-character app password, stored **without spaces**. Without them links are logged, not sent. |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_SLUG` | Reading a private portfolio | Optional but recommended: replaces the `repo` OAuth scope with per-repository `contents: read`. |
| `CRON_SECRET` | Scheduled jobs, `/api/health` detail | Any long random string. Without it the cron routes refuse every request. |
| `ALERT_EMAIL` | Failure alerts | Where the hourly draft-failure email goes. |
| `MAX_DRAFT_SECONDS` / `MAX_ASSESS_SECONDS` / `AI_ATTEMPT_TIMEOUT_MS` | Host time limits | Optional. Defaults suit a 30-second function; see `lib/ai/budget.ts`. |
| `APP_DAILY_MAX_CALLS` / `APP_DAILY_MAX_TOKENS` | Cost ceiling for everyone together | Optional; defaults 2,000 calls and 20M tokens a day. |
| `OWNER_EMAILS` | The owner's account | Your own address. No daily quota and outside the shared pool; still bound by a burst limit of 240 AI requests per 10 minutes (60 for every other account), and a separate one for connecting and syncing a portfolio: 600 per 10 minutes (300 for everyone else), 1,200 per connection (600), with a Sentry alert past `OWNER_ALERT_CALLS` (1,000) a day. |
| `SERPAPI_API_KEY` / `SERP_MODE` | Job Radar | Optional. Blank key = replay mode on synthetic sample data. [serpapi.com](https://serpapi.com) free plan for live. |
| `RADAR_PUBLIC_DEMO` | Public `/radar?demo=1` in production | `1` to allow the scripted demo without login. |
| `SIGNUP_MODE` / `AUTO_APPROVE_DAILY_QUOTA` | Who may use a new account | Optional. `invite` (default), `open` or `manual`; quota default 20 a day. See "Roles and sign-up". |
| `AI_DISABLED_PROVIDERS` / `AI_PII_PROVIDERS` | Provider allow and deny lists | Optional. Comma lists of provider ids. |
| `FIRECRAWL_API_KEY` | Optional | Only needed to paste job *links*. Pasting job *text* always works. |

`.env.example` documents the rest (every variable the code reads, grouped as required and
optional), including the tuning variables for the sync, the provider chain, kill-switch
overrides, logging, Sentry and heartbeats.

### 3. Create tables

**Versioned migrations (preferred from 2026-10-08).** The schema now has a migration history in
`drizzle/` (`0000_baseline.sql` is the whole schema as of that date).

```bash
npm run db:migrate           # fresh database: applies every pending migration
npm run db:migrate:status    # what is applied, what is pending
npm run db:generate          # after editing lib/db/schema*.ts: writes the next drizzle/NNNN_*.sql
npm run db:baseline          # EXISTING database built by db:push + scripts/*.sql: mark it as at
                             # baseline without running anything (refuses on an empty database)
```

A schema change is a reviewed pair: edit the schema, run `db:generate`, commit the generated SQL, apply
it with `db:migrate`, and never edit an applied migration file. `tests/db-migrations.test.mts` fails
if `lib/db/schema*.ts` and `drizzle/` disagree, so a schema change without a migration cannot reach CI
green. The maintainer's production database was marked at baseline on 2026-10-08 after its structure
was compared with the baseline (380 objects each, no differences).

For a throwaway database only:

```bash
npm run db:push        # base schema from lib/db/schema*.ts
```

The SQL files in `scripts/` are the history from before migrations existed (and what was applied by hand
to production, in filename order, over a direct non-pooled connection). Every file is additive and
idempotent (`IF NOT EXISTS`), so re-running one is harmless. They are not needed on a database created
with `db:migrate`:

1. `2026-09-12-dismissed-record.sql`
2. `2026-09-12-enrichment-preference.sql`
3. `2026-10-06-job-radar.sql` (`agent_run`, `serp_cache`)
4. `2026-10-07-ai-call-telemetry.sql` (`ai_call`)
5. `2026-10-07-consent-invites.sql` (`user_consent`, `invite_code`, `invite_redemption`)
6. `2026-10-07-ops-indexes-flags.sql` (indexes, `app_setting`)
7. `2026-10-07-radar-reliability.sql` (`agent_run.attempts`, `radar_search` ledger)
8. `2026-10-08-draft-idempotency.sql` (`draft_run.idempotency_key` and its unique index)

Apply a file before deploying the code that uses it; old code keeps working against the new
schema.

### 4. Run

```bash
npm run dev
```

---

## Roles, sign-up and kill switches

- **Owner.** Addresses in `OWNER_EMAILS` are approved automatically, have no daily AI quota
  (they still have a burst limit) and can open `/admin/approvals`, `/admin/invites` and
  `/admin/flags`.
- **Everyone else starts `pending`.** A pending account can sign in, reach `/pending` and
  delete itself; every other page redirects there and AI calls are refused. The owner approves
  or denies at `/admin/approvals`, or the account is approved by an invite code or by `open`
  sign-up under a daily quota.
- **`SIGNUP_MODE`:** `invite` (default: a valid code entered on `/pending` approves, otherwise
  the owner decides), `open` (every new account is auto-approved) or `manual` (codes are
  ignored). `AUTO_APPROVE_DAILY_QUOTA` (default 20, counted per IST day) caps automatic approvals
  in both `invite` and `open` modes. Codes are created at `/admin/invites`, stored hashed.
- **Consent.** Before using the app a user accepts the current privacy policy and terms and
  attests to being 18 or older; the version is recorded in `user_consent`, and a version bump
  sends everyone back to `/consent`.
- **Sessions** last 7 days; a password reset signs out every session.
- **Kill switches** at `/admin/flags` (owner only, every change in `audit_log`):
  `radar_enabled`, `ai_enabled`, `signups_enabled` and a `maintenance_message` banner. They take
  effect within about 15 seconds per instance. An env var `FLAG_<KEY>` (for example
  `FLAG_RADAR_ENABLED=false`) overrides the table and works with the database down. If the
  settings table cannot be read the switches fail open to their defaults. A single AI
  provider can be removed with `AI_DISABLED_PROVIDERS`.

---

## Observability

- **`GET /api/health`** returns `{"status":"ok"}` (200) or `degraded` (503) from a `select 1`.
  With the `x-cron-secret` header it also reports env validation, tables present, stuck radar
  runs, cron heartbeats, provider order and SerpApi credits left. No secret value is returned.
- **Sentry** is on only where `NEXT_PUBLIC_SENTRY_DSN` is set: errors only, no replay, request
  bodies, cookies and query strings removed, tokens, emails and phone numbers redacted.
- **Logs** are one JSON line per event (`lib/log.ts`), scrubbed with the same redactor.
- **Scheduled jobs** (Netlify, UTC): housekeeping daily 03:30 (retention sweep), portfolio
  freshness 04:15, draft alerts hourly at :05. Each can ping a dead-man's-switch
  (`HEARTBEAT_URL_*` or `HEALTHCHECKS_BASE_URL`). Alert emails go to `ALERT_EMAIL`: failed
  drafts, SerpApi credits low, stuck radar runs, database down.

Procedures: [`RUNBOOK.md`](./RUNBOOK.md). Reference: [`docs/production/OPERATIONS.md`](./docs/production/OPERATIONS.md).

---

## Security highlights

- Every generated claim is checked against the user's own records in code, not only in a prompt.
- Untrusted text (job postings, scraped pages, profile free text) is wrapped in per-call
  nonce-delimited fences with look-alike delimiters stripped (`lib/ai/fence.ts`); contact
  details are redacted from prompts that do not need them (`lib/ai/redact.ts`).
- User-supplied URLs are fetched through an SSRF-hardened client that resolves once, requires
  public addresses and pins the connection to the validated IP (`lib/net/safe-fetch.ts`).
- OAuth tokens are encrypted at rest with AES-256-GCM (`TOKEN_ENC_KEY`).
- Every radar and draft read is scoped to the signed-in user; the radar API checks same
  origin, content type and body size and validates the body strictly.
- Cron routes use a timing-safe secret check and refuse everything when `CRON_SECRET` is unset.
- SerpApi and provider keys are server-only and scrubbed from error text.
- Known gaps: the CSP still allows `'unsafe-inline'` scripts, there is no MFA or CAPTCHA, and
  there is no key rotation for `TOKEN_ENC_KEY`. See
  [`docs/production/READINESS.md`](./docs/production/READINESS.md).

---

## Production readiness

This is a strong single-owner engine, not yet a production service for the public. The current
status of every audited gap (done, partial, open) is at the top of
[`docs/production/READINESS.md`](./docs/production/READINESS.md); legal placeholders awaiting
counsel are in [`docs/production/LEGAL-REVIEW.md`](./docs/production/LEGAL-REVIEW.md); the
owner's settled choices (privacy, retention, pricing, access) are in
[`docs/production/DECISIONS.md`](./docs/production/DECISIONS.md).

---

## Verifying it works

```bash
npm test                      # every tests/*.test.mts suite, each in its own process
npm run typecheck             # the app, and the tests and scripts (both run in CI)
npm run lint
npx tsx scripts/smoke.mts     # 18 checks: scorers, grounding guard, retrieval, sync, DOCX round-trip
npx tsx scripts/ai-check.mts  # confirms your AI provider chain actually responds
```

There are 105 suites (`tests/*.test.mts`, counted 2026-10-08; other work may add more). They are offline and need no keys. The ones named
`db-*` (8 of them: approval, dismissals, enrichment, radar, rate limit, routes, sync, sync
review) run the real application modules against an in-memory Postgres (PGlite) through a
stand-in `@/lib/db` (`tests/db/`), so no database server is needed. Radar and SerpApi are
covered by `radar-*`, `serp-*`, `budget*` and `db-radar` (planner, ranker, market, state
transitions, the async protocol, reservations, key never in errors). Draft idempotency is in
`draft-idempotency`. CI (`.github/workflows/ci.yml`) runs audit, types, lint, tests, build
and a PDF check without the native canvas. The `scripts/verify-*.mts` harnesses need a real
database and are not in CI.

`tests/grounding.test.mts` is the one worth knowing about: it generates thousands of
source/rewrite pairs and asserts that every number and proper noun in an *accepted*
rewrite came from the source, checked by a second scanner written independently of the
guard. It has already caught a real leak.

With the dev server running, `GET /api/dev/selftest` renders a fixture resume to PDF,
DOCX and presentation-mode PDF, parses all three back to text, and returns exactly what
an ATS would read. (Dev only — 404s in production.)

---

## How a draft runs

```
sync ──► understand ──► retrieve ──► draft ──► score ⇄ revise ──► finalize
```

1. **sync** — compares your portfolio repo's latest commit SHA against the last one
   synced. Unchanged means zero work; changed means re-parse and reconcile.
2. **understand** — turns a link, a full JD, a LinkedIn post, or a bare job title into one
   structured `JobRequirement`, with a sanity check that flags contradictory postings.
3. **retrieve** — applies a per-role-category relevance floor *before* ranking, so an SEO
   resume can't surface a Kubernetes bullet just because the similarity math liked it.
4. **draft** — rewrites selected bullets toward the posting's vocabulary, verified against
   source.
5. **score / revise** — the quality gate loop.
6. **finalize** — renders PDF + DOCX and round-trip tests both.

Every stage streams to the browser as it happens (SSE), including live per-iteration
scores. Nothing shown is simulated.

---

## Provider routing

Providers are tried in order and fall back on failure or rate-limit:

**Fireworks AI → Groq → Together AI → DeepInfra → Gemini**

(`/api/health` with the `x-cron-secret` header reports the live order and the effective
time limits.)

Only providers with a key present are included, so it works with whatever subset you
have. Every model ID is overridable by env var — deliberately, because these providers
retire model IDs regularly (Groq especially). If one starts failing with "model not
found", change the env var rather than editing code.

Structured output has two paths: native schema mode where the provider supports it, and
a JSON-text path with Zod validation where it doesn't. Several open-weight models can't
do schema-constrained output, and this keeps them usable without weakening validation.

A per-provider circuit breaker (3 failures in a row open it for 30 s) and a 6-hour bench for a
provider whose model id was retired keep a failing provider from eating the time budget.
`AI_DISABLED_PROVIDERS` removes providers and `AI_PII_PROVIDERS` limits which ones may receive
prompts containing personal data. Each attempt is recorded in the `ai_call` table (provider,
model, stage, tokens, latency, error class; never prompt text). The evidence-quality judge
takes two votes at different temperatures and keeps the lower grade per line.

Hard cost caps apply per draft, per user per day, and for the whole deployment per day,
enforced regardless of whether the score has converged — a stuck loop can't quietly run
up a bill, and neither can a stranger signing up.

---

## Project layout

```
app/                    routes, layout, SEO metadata (sitemap, robots, JSON-LD)
components/             logo, live pipeline console, setup checklist
lib/
  ai/         provider chain, model config, budgets, circuit breaker, cooldowns, telemetry, prompt fence and redaction
  radar/      Job Radar: planner, ranker, market signal, stepped run orchestrator, handlers
  serp/       SerpApi client (async + archive), credit budget and cache, normalisers, replay fixtures
  legal/      policy versions, consent, invite codes
  net/        SSRF-hardened fetch
  intake/     job URL scraping + structured extraction
  retrieval/  role categories, relevance floor, hybrid ranking
  generate/   grounded rewrite, anti-fabrication guard, assembly, revision
  quality/    keyword gate, formatting, skills, evidence, the loop
  render/     PDF, DOCX, headings, dates, filenames, round-trip self-test
  sync/       GitHub SHA gate, portfolio parsing, reconciliation
  import/     old-resume upload: text extraction, chunked AI pass, confirmed commit
  server/     database access, dashboard queries
scripts/      smoke tests
tests/        scorer units, grounding property tests, known-bad documents (`npm test`)
netlify/      scheduled functions: daily housekeeping, daily portfolio-freshness check, hourly failure alert
specs/        requirements, design, tasks
```

---

## Deploying

### Either host works, and the difference is the clock

This runs in production on Netlify's free plan, where a function is killed at 30
seconds. That is the whole reason for the time budget in `lib/ai/budget.ts`: the draft
stops early with the best resume it has rather than being killed with nothing. Set
`MAX_DRAFT_SECONDS` to your host's real limit minus a margin — read it from your own
function logs, not from the docs.

| | Vercel | Netlify free |
| --- | --- | --- |
| Max function duration | 300s | 30s, measured |
| Effect here | all four scoring iterations | two or three, and it says so |

On Netlify, `netlify.toml` pins Node 22 and the Next.js runtime plugin, and the three
scheduled functions in `netlify/` need `CRON_SECRET` set. The `maxDuration` exports in
the routes are Vercel's; Netlify ignores them.

### Steps (Vercel)

1. **Push to GitHub**, then import the repo at [vercel.com/new](https://vercel.com/new).
   Next.js is detected automatically — no build configuration needed.

2. **Add environment variables** in Project Settings → Environment Variables. Everything
   from `.env` except `NEXT_PUBLIC_SITE_URL`, which is auto-detected:

   ```
   DATABASE_URL, AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET,
   DEEPINFRA_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY,
   GITHUB_WEBHOOK_SECRET          (optional)
   FIRECRAWL_API_KEY              (optional)
   GOOGLE_GENERATIVE_AI_API_KEY   (optional)
   GROQ_API_KEY                   (optional)
   ```

3. **Set the function region to match your database.** Project Settings → Functions →
   Region. A Mumbai/Singapore database with functions left on the US default means every
   query crosses an ocean, several times per page.

4. **Deploy**, then note the URL Vercel assigns.

5. **Add the production callback to your GitHub OAuth App.** GitHub OAuth Apps support
   multiple callback URLs, so one app covers both environments — add:

   ```
   https://<your-vercel-url>/api/auth/callback/github
   ```

   alongside the existing localhost one. (Exact match is required; there's a wildcard
   option but it widens your attack surface, so prefer listing both explicitly.)

6. **Point the webhook at production** (optional): repo Settings → Webhooks → payload URL
   `https://<your-vercel-url>/api/webhook/github`, content type `application/json`,
   secret = your `GITHUB_WEBHOOK_SECRET`. This can't work against localhost, which is why
   it's a post-deploy step.

7. **Custom domain later:** once you point a real domain at it, set
   `NEXT_PUBLIC_SITE_URL` explicitly so canonical URLs and Open Graph tags use the domain
   rather than the `.vercel.app` host.
