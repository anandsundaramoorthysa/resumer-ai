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
| At least one AI key | Generation | Gemini, Groq, DeepInfra, Together, or Fireworks |
| `FIRECRAWL_API_KEY` | Optional | Only needed to paste job *links*. Pasting job *text* always works. |

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
npx tsx scripts/smoke.mts     # 18 checks: scorers, grounding guard, retrieval, sync, DOCX round-trip
npx tsx scripts/ai-check.mts  # confirms your AI provider chain actually responds
```

With the dev server running, `GET /api/dev/selftest` renders a fixture resume to PDF and
DOCX, parses both back to text, and returns exactly what an ATS would read. (Dev only —
404s in production.)

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

**Gemini → Groq → DeepInfra → Together AI → Fireworks AI**

Only providers with a key present are included, so it works with whatever subset you
have. Every model ID is overridable by env var — deliberately, because these providers
retire model IDs regularly (Groq especially). If one starts failing with "model not
found", change the env var rather than editing code.

Structured output has two paths: native schema mode where the provider supports it, and
a JSON-text path with Zod validation where it doesn't. Several open-weight models can't
do schema-constrained output, and this keeps them usable without weakening validation.

Hard cost caps apply per draft and per day, enforced regardless of whether the score has
converged — a stuck loop can't quietly run up a bill.

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
  server/     database access, dashboard queries
scripts/      smoke tests
specs/        requirements, design, tasks
```

---

## Deploying

### Use Vercel, not Netlify

This is a hosting constraint, not a preference. A draft runs job extraction, retrieval,
up to four scoring iterations, then PDF/DOCX rendering and a round-trip parse — routinely
30–90 seconds. The draft route declares `maxDuration = 300`.

| | Vercel | Netlify |
| --- | --- | --- |
| Max function duration | 300s (default on Fluid Compute) | 10s sync, 26s paid, 60s streaming |
| SSE streaming | Works on the Node runtime | Capped at 60s, stops at 10s if the sync limit is hit |
| Node APIs for PDF/DOCX | Yes | Yes |

Netlify would time out mid-draft on almost every real resume.

### Steps

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
