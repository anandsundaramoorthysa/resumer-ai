# Resumer AI

One profile, every role. Resumer AI keeps a single professional profile in sync with your
portfolio, tailors an ATS-safe resume to any job posting, and scores and revises that
resume until it clears a quality bar — before you ever see it.

- **Plan and rationale:** [`PLAN.md`](./PLAN.md)
- **Specs:** [`specs/requirements.md`](./specs/requirements.md) · [`specs/design.md`](./specs/design.md) · [`specs/tasks.md`](./specs/tasks.md)

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
| `OWNER_EMAILS` | The owner's account | Your own address. No daily quota and outside the shared pool; still bound by a burst limit of 240 AI requests per 10 minutes (60 for every other account), with a Sentry alert past `OWNER_ALERT_CALLS` (1,000) a day. |
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
npm test                      # 49 suites: scorers, grounding property tests, known-bad
                              # documents, importer chunking and merge
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
