# Submission: SerpApi India Hackathon 2026

Deadline: 2026-10-10 23:59 IST. Text below is form-ready; facts were checked against the code on 2026-10-08 and again on 2026-10-09 (after the merge to `main`); `main` has since had documentation-only changes.

## Form fields (copy-paste)

Everything the form asks for, in one place. The only value still to fill is the video link.

```
Project name:      Resumer AI, with Job Radar
Tagline:           Job search that shows its sources and never invents facts: SerpApi finds
                   the openings, your verified profile ranks them, and a grounded tailor
                   writes the resume.
Track (one only):  Knowledge & Public Interest   (the form takes one track; SerpApi may reassign)
Predates event:    Yes. Resumer AI existed before the hackathon (base commit 14fcb20, 12 Sep 2026);
                   Job Radar and the UI redesign were built for it. Details: prior-existence section.
How you heard:     (your answer)
Lead details:      name, email, mobile, occupation, years of experience (not in the repo)
Repo (public):     https://github.com/anandsundaramoorthysa/resumer-ai
Live URL:          https://resumeraiapp.netlify.app
Demo (no login):   https://resumeraiapp.netlify.app/radar?demo=1
Video (<3 min):    <PENDING — paste the link here>  (screen recording of the local demo; narration is optional per the rules)
Built with:        Next.js 16, React 19, TypeScript, Tailwind CSS v4, Drizzle ORM on
                   Postgres (Neon), NextAuth (GitHub OAuth), Vercel AI SDK with Groq /
                   Fireworks AI / Together AI / DeepInfra / Google Gemini, SerpApi
                   (google_jobs, google, google_news, account.json), Netlify functions and
                   scheduled functions, react-pdf / docx / pdf-parse / mammoth for
                   rendering and import.
SerpApi APIs used: google_jobs (async submit + Search Archive read), google
                   ("<company> reviews"), google_news, account.json (free credit check).
AI tools used:     Developed with Claude Code (Anthropic) for planning, code, tests and
                   documentation. At runtime the app calls Groq, Fireworks AI, Together
                   AI, DeepInfra and Gemini; ranking, salary parsing, market signal and all
                   SerpApi handling are deterministic code.
Judging note:      /radar?demo=1 needs no login, no database and no key (it runs on
                   labelled synthetic sample data). A real run needs the env in the README.
```

Description, prior-existence and SerpApi-detail text: the sections below.

## Project name

Resumer AI, with Job Radar

## One-line pitch

Job search that shows its sources and never invents facts: SerpApi finds the openings, your verified profile ranks them, and a grounded tailor writes the resume.

## Description (about 150 words)

Resumer AI keeps one verified professional profile and tailors an ATS-safe resume to any job, rejecting any rewritten claim that is not in the user's real records. Job Radar, built for this hackathon, removes the step before that: finding the job. A planner proposes a few Google Jobs searches from the user's roles, skills and city, and the user approves them before any credit is spent. SerpApi's google_jobs engine runs asynchronously and is read back from the Search Archive; google_news adds recent headlines and a Google reviews search adds employer ratings. Code, not a model, ranks every posting against the profile and shows matched and missing skills, plus a salary and in-demand-skills signal. The user picks one posting and it flows into the grounded tailor. Runs are stepped and stored in Postgres, so they fit a 30-second serverless limit, and a cache, credit reservations and caps keep a run to a handful of the 250 free monthly searches.

## Track

- **Primary: Knowledge & Public Interest.** Job seekers in India, especially freshers, face scattered listings, opaque scores and resumes padded with claims they cannot defend. Radar turns public search results into evidence a person can check: sources are shown, salary figures say whether they were detected or estimated, and nothing is applied on the user's behalf.
- **Also relevant (not a second submission; the form takes one track): AI Agents.** Radar is a multi-agent pipeline (planner, searcher, ranker, employer-intel, market-signal, tailor, critic) with two human approval gates, budgets and a visible event timeline. Most of the agents are deterministic code on purpose, and a model is used only where language is needed.

## How SerpApi is used (core, not decoration)

Without SerpApi, Radar has nothing to run on. Three engines carry the product, plus the Search Archive:

- `google_jobs` (gl=in, hl=en, google_domain=google.co.in, page 1): discovery of postings, with apply links, highlights and salary where present. Submitted with `async=true`, then read from the **Search Archive** in a later request (archive reads are free and honour `json_restrictor`). This is what lets a run fit inside a 30-second function: every HTTP call is capped at 8 s.
- `google` (`"<company> reviews"`): employer ratings. `google_jobs_listing` is also called, but it returned nothing for most postings when tested live on 2026-10-08, so the rating normally comes from this fallback and is labelled `<Site> (via Google)`.
- `google_news` (quoted company name plus "company India", results filtered to the company): recent employer headlines.
- `account.json`: a free call used to stop spending when few credits remain.

Employer intel runs for the top two ranked companies. Every upstream billable call has its credits reserved in SQL and a ledger row written before it is sent, so a retried step cannot pay twice. An empty answer is billed (1 credit, verified live), so empty answers are cached for 10 minutes.

The architecture is shaped around the free plan (250 searches a month, 50 an hour): a 1 h / 24 h cache, single-flight for identical concurrent searches, 3 runs a day per user (reset at midnight IST) and 12 credits a run, hourly and monthly guards, and a labelled replay mode so the product degrades visibly instead of failing or overspending.

## Prior-existence disclosure

Resumer AI existed before the hackathon. Base commit `14fcb20` (12 Sep 2026) already contained profile import and sync, the grounded resume tailor, the quality-gate loop, PDF/DOCX rendering, cover letters, the application tracker, auth and cost guardrails.

Built during the hackathon window, on top of that commit: Job Radar (SerpApi layer with async search, cache and credit reservations; planner, ranker and market agents; the stepped run orchestrator; the `/radar` UI with approval gates and handoff to the tailor), the UI redesign, and a hardening pass (draft idempotency, AI provider circuit breaker and telemetry, consent, invite codes and kill switches, ops and health endpoints, embedded Indic fonts, CI). Git history shows the boundary: everything after `14fcb20`.

## AI-tools disclosure

Developed with Claude Code (Anthropic) for planning, code, tests and documentation. At runtime the app calls Groq, Fireworks AI, Together AI, DeepInfra and Gemini (whichever keys are configured) for the planner call, resume rewriting, critique and evidence grading. Ranking, salary parsing, market signal and all SerpApi handling are deterministic code.

## Setup summary

No keys needed to try it (Node 22 required; a dependency fails the install check on Node 20):

```bash
npm install
cp .env.example .env     # SERP_MODE=replay is the example value
npm run dev
# open http://localhost:3000/radar?demo=1
```

The demo and the replay data are synthetic sample data and are labelled as such. The demo runs in the browser with no login, database or key; it is available whenever `NODE_ENV` is not `production`, and in a production build with `RADAR_PUBLIC_DEMO=1`. For a real run: Postgres, GitHub OAuth, `AUTH_SECRET`, `TOKEN_ENC_KEY`, one AI key, `npm run db:push` plus the SQL files in `scripts/` in filename order, `OWNER_EMAILS`, and `SERPAPI_API_KEY` with `SERP_MODE=live`. Full steps are in the README.

Honest limits: free-tier AI capacity is small (roughly 10-15 drafts a day on Groq's free plan), the SerpApi free plan is 250 searches a month, and the PDF text layer for Devanagari and Tamil names is in visual glyph order, so an ATS may misread them.

## Demo video script (under 3 minutes)

The rules ask for a screen recording of the project running locally. Two options: record the scripted `/radar?demo=1` (sample data, no setup), or a real signed-in run. For a real run, spend a few credits first (`SERP_MODE=record` saves real responses to `fixtures/serpapi/`; check those files before committing them). Hide `.env`, API keys, your email and any personal data (use a sample profile). If the recording uses sample data, say so on screen.

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | Title card or landing page | The problem: job boards are noisy, resume tools invent facts. Resumer AI never invents; Radar finds jobs the same way. |
| 0:20 | /radar, start a run | Radar reads a verified profile and plans searches. The planner is one model call, with a rules fallback. |
| 0:35 | Query gate: edit one query, remove one, "Run these searches" | First human gate: no SerpApi credit is spent until I approve. Credit meter visible. |
| 0:55 | Timeline: search submitted, "Waiting for N searches to finish" | SerpApi's google_jobs runs asynchronously: submit returns an id in about 300 ms, then the app reads the Search Archive. That is how it fits a 30-second function. Every timeline line is a real step with its source. |
| 1:20 | Ranked list | Ranking is plain code against my profile: matched and missing skills per posting, no per-result AI call. |
| 1:40 | Employer intel and market card | Headlines from google_news, a rating labelled "via Google", salary in LPA with a note when it is estimated, skills I lack. |
| 2:00 | Pick a posting, "Tailor my resume" | Second gate: I choose. The posting goes to the grounded tailor: fit check, rewrite, critic score. |
| 2:25 | Apply link, sample-data banner if shown | Apply opens the original posting; nothing auto-applies. Without credits it shows a "sample data" banner instead of failing. |
| 2:45 | Closing | Three SerpApi engines plus the archive, a handful of credits per run, cached and guarded. Repo link and README. |

## Pre-submission checklist

Done:

- [x] LICENSE added: PolyForm Noncommercial 1.0.0 with a paid commercial option (see LICENSE and COMMERCIAL-LICENSE.md). The hackathon rules say an open-source license is encouraged but not required.
- [x] README rewritten for this release: judge quickstart, full setup with SQL apply order, roles, kill switches, observability, testing.
- [x] `.env.example` lists every variable the code reads, with placeholders only.
- [x] SerpApi usage, prior-existence and AI-tools disclosures drafted above.
- [x] **Repo is PUBLIC** (`anandsundaramoorthysa/resumer-ai`, checked 2026-10-08). `.env` has never been tracked; only `.env.example` is.
- [x] Owner decisions recorded in `docs/production/DECISIONS.md` (grievance contact, 18+ gate, retention, providers, plans).
- [x] **Merged to `main`; the default branch holds the final code.** the code was merged in PR #9 on 2026-10-09 (later `main` commits are docs only), on top of the branch tip `8a44a59` merged 2026-10-08. The `scripts/*.sql` files were applied to production in filename order first (file 9 confirmed on the production column on 2026-10-08 — `docs/production/OPERATIONS.md` §4). Netlify production builds from `main`; `main` now enforces required status checks (`check`, `coverage`, `gitleaks`), so later changes go through a PR. The `/consent` re-prompt for existing accounts is accepted (decision 18).
- [x] Secrets scan: CI gitleaks passes over the **full history**. `.gitleaks.toml` allowlists exactly four test fixtures whose fake tokens are the thing being tested; nothing else is exempt. `.env` has never been tracked.
- [x] Fixtures contain no personal data: all five files under `fixtures/serpapi/` are hand-written and carry `"_synthetic": true` ("not real postings, companies or links"). No `SERP_MODE=record` capture was committed, and that is the only fixture directory (checked 2026-10-09).
- [x] `npm test`, `npm run typecheck` and `npm run lint` pass on the merged commit — the CI `check` job (typecheck, lint, 122 test suites, build, PDF-without-canvas) and `coverage` (all floors met) run on every PR; both were green on PR #9.

Still to do:

- [ ] README quickstart confirmed from a fresh clone with only `.env.example` copied. (Node 22 is required — the AI SDK declares `>=22`; this machine runs Node 20, so clone-and-run on 22 was not verifiable here.)
- [ ] Demo video recorded, under 3 minutes, opens in an incognito window, shows the project running locally, hides keys and personal data. Video link added to the form and to the copy-paste block above. *(Owner decision: deliberately pending.)*
- [ ] Form submitted with the copy-paste block above, before 2026-10-10 23:59 IST (submit today).
