# Resumer AI

One profile, every role. Resumer AI keeps a single professional profile in sync with your
portfolio, tailors an ATS-safe resume to any job posting, and scores and revises that
resume until it clears a quality bar — before you ever see it.

- **Plan and rationale:** [`PLAN.md`](./PLAN.md)
- **Specs:** [`specs/requirements.md`](./specs/requirements.md) · [`specs/design.md`](./specs/design.md) · [`specs/tasks.md`](./specs/tasks.md)

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
- **Employer intel.** Ratings via `google_jobs_listing` and recent headlines via
  `google_news` for the top companies.
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
| `google_jobs` | `q="<role> <city>"`, `gl=in`, `hl=en`, `google_domain=google.co.in`, `json_restrictor`; page 1 only | Posting discovery |
| `google_jobs_listing` | `q=<job_id>`, `gl=in`, `hl=en`, `google_domain=google.co.in` | Employer ratings (absence tolerated) |
| `google_news` | `q=<company>`, `so=1`, `gl=in`, `hl=en` | Recent employer headlines |
| `account.json` | free endpoint | Guard: remaining monthly searches, memoized 5 min |

### Credit budgeting

SerpApi's free plan is 250 searches a month (and 50 an hour), so the radar is built to spend
very little:

- **Cache:** identical requests are served from the `serp_cache` table, 1 hour for jobs and
  24 hours for news and listings. Cache hits cost nothing.
- **Per-user limits:** 3 runs per day and at most 12 credits per run (a default run is
  roughly 4-7).
- **Account guards:** searches are blocked when `account.json` reports fewer than 10 left, or
  when 45 live searches were stored in the past hour.
- **Replay fallback:** when blocked, or when no key is set, results come from the bundled
  fixtures, and the run shows a visible "showing sample data" banner. It never falls back
  silently.

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
POST /api/radar ─► plan ─► [gate 1: approve queries] ─► search (all queries, parallel)
                                                          │
          done ◄─ [gate 2: pick a posting] ◄─ intel (parallel) ◄─ rank (+ market signal)
            │
            └─► draft console (grounded tailor, critic loop)
```

Each step commits with `UPDATE ... WHERE step = expectStep`, so two tabs cannot both advance
a run. A failed query or company is a warning and is skipped; only a failed plan or every
search failing ends the run in error. Details: [`docs/hackathon/ARCHITECTURE.md`](./docs/hackathon/ARCHITECTURE.md).

### Privacy and security

- Only role, skill and city text is sent to SerpApi. Name, email, phone and links are not.
- `SERPAPI_API_KEY` is server-only (no `NEXT_PUBLIC_` variant), is never logged, and is
  scrubbed from every error string before it can reach the browser or Sentry.
- Every run is read and written under the signed-in user's id; another user's run looks
  like a missing one.
- Messages shown in the browser are authored by the app, never upstream error text.

### Tests

Offline, no key needed (`npm test`): `radar-planner`, `radar-ranker`, `radar-market`,
`radar-state` (transitions, cancel, stale `expectStep`), `serp-client` (stubbed fetch:
request params, cache hit, budget block, missing key, key never in errors),
`serp-normalize`, `serp-salary`.

### Judge quickstart (no keys)

```bash
git clone <this repo> && cd resumer-ai
npm install
cp .env.example .env        # then set SERP_MODE=replay (the example value)
npm run dev
```

Open <http://localhost:3000/radar?demo=1>. This is a public, scripted demo that runs in the
browser on sample data: no login, database or API key. It works in dev; in production it
needs `RADAR_PUBLIC_DEMO=1`.

### Full setup (real accounts, real runs)

1. Postgres (`DATABASE_URL`), GitHub OAuth (`AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`),
   `AUTH_SECRET`, `TOKEN_ENC_KEY`, and at least one AI provider key (see Setup below).
2. Create the tables: `npm run db:push` (or apply `scripts/2026-10-06-job-radar.sql` by hand).
3. Put your address in `OWNER_EMAILS` so your account is approved (new accounts wait for
   owner approval).
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

License: to be added by the owner before the repo is made public.

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
| `FIRECRAWL_API_KEY` | Optional | Only needed to paste job *links*. Pasting job *text* always works. |

`.env.example` documents the rest, including the tuning variables for the sync and the
provider chain.

### 3. Create tables

```bash
npm run db:push
```

### 4. Run

```bash
npm run dev
```

---

## Verifying it works

```bash
npm test                      # offline suites: scorers, grounding property tests, known-bad
                              # documents, importer chunking and merge, Job Radar and SerpApi
npm run typecheck             # the app, and the tests and scripts (both run in CI)
npx tsx scripts/smoke.mts     # 18 checks: scorers, grounding guard, retrieval, sync, DOCX round-trip
npx tsx scripts/ai-check.mts  # confirms your AI provider chain actually responds
```

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

Hard cost caps apply per draft, per user per day, and for the whole deployment per day,
enforced regardless of whether the score has converged — a stuck loop can't quietly run
up a bill, and neither can a stranger signing up.

---

## Project layout

```
app/                    routes, layout, SEO metadata (sitemap, robots, JSON-LD)
components/             logo, live pipeline console, setup checklist
lib/
  ai/         provider chain, model config, budget circuit breaker
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
netlify/      scheduled functions: daily portfolio-freshness check, hourly failure alert
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

On Netlify, `netlify.toml` pins Node 22 and the Next.js runtime plugin, and the two
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
