# Submission: SerpApi India Hackathon 2026

Deadline: 2026-10-10 23:59 IST.

## Project name

Resumer AI, with Job Radar

## One-line pitch

Job search that shows its sources and never invents facts: SerpApi finds the openings, your verified profile ranks them, and a grounded tailor writes the resume.

## Description (about 150 words)

Resumer AI keeps one verified professional profile and tailors an ATS-safe resume to any job, rejecting any rewritten claim that is not in the user's real records. Job Radar, built for this hackathon, removes the step before that: finding the job. A planner proposes a few Google Jobs searches from the user's roles, skills and city, and the user approves them before any credit is spent. SerpApi's google_jobs engine returns postings, google_jobs_listing adds employer ratings, and google_news adds recent headlines. Code, not a model, ranks every posting against the profile and shows matched and missing skills, plus a salary and in-demand-skills signal for the market. The user picks one posting and it flows into the grounded tailor. Runs are stepped and stored in Postgres, so they work inside a 30-second serverless limit, and a cache plus credit guards keep a run to a handful of the 250 free monthly searches.

## Track

- **Primary: Knowledge & Public Interest.** Job seekers in India, especially freshers, face scattered listings, opaque scores and resumes padded with claims they cannot defend. Radar turns public search results into evidence a person can check: sources are shown, salary figures say whether they were detected or estimated, and nothing is applied on the user's behalf.
- **Secondary: AI Agents.** Radar is a multi-agent pipeline (planner, searcher, ranker, employer-intel, market-signal, tailor, critic) with human approval gates, budgets and a visible event timeline. Most of the agents are deterministic code on purpose, and the model is used only where language is needed.

## How SerpApi is used (core, not decoration)

Without SerpApi, Radar has nothing to run on. Three engines carry the product:

- `google_jobs` (gl=in, hl=en, google_domain=google.co.in): discovery of postings, with apply links, highlights and salary where present.
- `google_jobs_listing`: employer ratings for the top companies.
- `google_news` (so=1, gl=in): recent employer headlines.
- `account.json`: a free call used to stop spending when few credits remain.

The whole architecture is shaped around the free plan: a 1h / 24h cache, per-user run and credit caps, hourly and monthly guards, and a labelled replay mode so the product degrades visibly instead of failing or overspending.

## Prior-existence disclosure

Resumer AI (profile sync, grounded resume tailoring, quality-gate loop, PDF/DOCX, cover letters, application tracker, auth and cost guardrails) existed before the hackathon; the last pre-hackathon commit is `14fcb20` (12 Sep 2026). Built during the hackathon window: Job Radar (SerpApi layer, cache and budget, planner / ranker / market agents, stepped orchestrator, approval-gated /radar UI, handoff to the tailor, tests) and the UI redesign. Git history shows the boundary.

## AI-tools disclosure

Developed with Claude Code (Anthropic) for planning, code and documentation. At runtime the app uses Groq, Fireworks AI, Together AI, DeepInfra and Gemini (whichever keys are configured) for the planner call, resume rewriting and critique. Ranking, salary parsing, market signal and all SerpApi handling are deterministic code.

## Setup summary

No keys needed to try it:

```bash
npm install
cp .env.example .env     # SERP_MODE=replay is the example value
npm run dev
# open http://localhost:3000/radar?demo=1
```

The replay data and the demo are synthetic sample data and are labelled as such. For a real run: Postgres, GitHub OAuth, `AUTH_SECRET`, `TOKEN_ENC_KEY`, one AI key, `npm run db:push`, `OWNER_EMAILS`, and `SERPAPI_API_KEY` with `SERP_MODE=live`. Full steps are in the README.

## Demo video script (under 3 minutes)

The rules ask for a screen recording of the project running locally. Before recording: run one real search set with `SERP_MODE=record` (a few credits) so the replay data is real for the recording, check the files in `fixtures/serpapi/`, then record. Hide `.env`, API keys, your email and any personal data (use a sample profile).

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | Title card or landing page | The problem: job boards are noisy, resume tools invent facts. Resumer AI never invents; Radar finds jobs the same way. |
| 0:20 | /radar, press start | Radar reads a verified profile and plans searches. The planner is one model call, with a rules fallback. |
| 0:35 | Query gate: edit one query, remove one | First human gate: no SerpApi credit is spent until I approve. Credit meter visible. |
| 0:55 | Timeline while searching | Every line is a real step with its source: serpapi:google_jobs, parallel searches, dedupe count. Mention the engines and gl=in. |
| 1:20 | Ranked list | Ranking is plain code against my profile: matched and missing skills per posting, no per-result AI call. |
| 1:40 | Employer intel and market card | Ratings from google_jobs_listing, headlines from google_news, salary in LPA with a note when it is estimated, skills I lack. |
| 2:00 | Pick a posting, open draft | Second gate: I choose. The posting goes to the grounded tailor: fit check, rewrite, critic score. |
| 2:25 | Apply link, replay banner | Apply opens the original posting; nothing auto-applies. Without credits it shows a "sample data" banner instead of failing. |
| 2:45 | Closing | Three SerpApi engines, a handful of credits per run, cached and guarded. Repo link and README. |

If the recording uses replay data, say so on screen.

## Pre-submission checklist

- [ ] Repo is public and the default branch has the final code.
- [x] LICENSE added: PolyForm Noncommercial 1.0.0 with a paid commercial option (see LICENSE and COMMERCIAL-LICENSE.md). The hackathon rules say an open-source license is encouraged but not required.
- [ ] Secrets scan passes on the working tree and history (for example `gitleaks detect`); `.env` is not committed.
- [ ] Fixtures recorded with `SERP_MODE=record` contain no personal data.
- [ ] README quickstart works from a fresh clone with only `.env.example` copied.
- [ ] `npm test` and `npm run typecheck` pass.
- [ ] Demo video is under 3 minutes and opens in an incognito window.
- [ ] Video shows the project running locally and hides keys and personal data.
- [ ] Track(s) and AI-tool disclosure are filled in on the form.
- [ ] Submitted before 2026-10-10 23:59 IST (aim for a day earlier).
