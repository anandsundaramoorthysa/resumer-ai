# Job Radar architecture

Principle: code decides and fetches; a model runs only where language is needed (the planner, and the existing tailor and critic).

## Components

| Piece | Where | Role |
| --- | --- | --- |
| API route | `app/api/radar/route.ts`, `lib/radar/handlers.ts` | Session, owner approval, same-origin, content type, body size and strict body checks, burst limit, `radar_enabled` kill switch; one call per step |
| Orchestrator | `lib/radar/runs.ts` | Run state machine, gates, step leases, credit reservations, compare-and-set commits |
| Events and bounds | `lib/radar/events.ts` | Event list (capped at 60), run state shape, posting cap (30), safe messages |
| Planner / Ranker / Market | `lib/radar/{planner,ranker,market}.ts` | Pure agents |
| SerpApi layer | `lib/serp/{client,budget,normalize,salary,fixtures,types}.ts` | Async submit and archive poll, cache, single-flight, guards, parsing, replay |
| Housekeeping | `lib/radar/housekeeping.ts` | Retention for `agent_run` and `serp_cache` |
| UI | `app/radar/page.tsx`, `components/radar/*` | Timeline, gates, results; `?demo=1` is scripted client-side sample data (`app/radar/demo-gate.ts`, `demo-status.ts`) |
| Handoff | `components/draft-console.tsx` | Takes job text from the chosen posting (sessionStorage keys `radar:jobText`, `radar:jobLabel`) and skips URL scraping |

## Tables

Radar (`lib/db/schema-radar.ts`):

- `agent_run`: `id`, `user_id` (cascade), `status` (running | awaiting | done | error | cancelled), `phase`, `step`, `total_steps`, `message`, `state` jsonb (plan, queries, postings, ranked, intel, market, selectedKey, gate, pending searches), `events` jsonb (append-only, capped 60), `credits_used`, `mode` (live | replay), `error`, timestamps, `leased_until` (the step lease), `attempts` (claims of the current step). Indexes: `(user_id, created_at)`, and a partial unique index allowing one active run (running or awaiting) per user.
- `radar_search`: the submission ledger, primary key `(run_id, key)`, cascade on the run. One row per billable upstream call, written together with its credit reservation before the HTTP call; `search_id` is filled right after the submit returns. This is what stops a killed and reclaimed step from submitting a query twice.
- `serp_cache`: `key` = sha256(engine + sorted params without `api_key`/`no_cache`), `engine`, `payload` jsonb, `fetched_at`. It also stores the `account.json` memo (engine `account`), `attempt` rows for the hourly count, `inflight` rows for single-flight, and short-lived `_empty` markers.

Elsewhere, added in this release:

- `user_consent`: user, policy version, terms version, 18+ attestation, accepted_at, source; unique on `(user_id, policy_version)`.
- `invite_code` (hashed code, max uses, uses, expiry, disabled) and `invite_redemption` (one per user).
- `app_setting`: key and value for the kill switches and maintenance banner, plus the `hb:<name>` cron heartbeats.
- `ai_call`: one row per model attempt (stage, provider, model, path, prompt version, tokens, latency, error class, finish reason). No prompt text.
- `draft_run.idempotency_key`, unique per `(user_id, idempotency_key)` where not null.

## Run state machine

```
plan -> awaiting-queries -> search -> poll (repeats) -> rank (+market) -> intel -> select -> done
          (gate 1)        (async submit)  (archive reads)                (parallel) (gate 2)
```

`totalSteps` is 7 with employer intel and 6 without (intel is optional per run). `error` and `cancelled` are the other terminal states. Gates set `status = awaiting` with `state.gate` of `queries` or `select`. In replay mode and in tests the search step completes without polling.

## Protocol (`/api/radar`, JSON, `Cache-Control: no-store`, session required)

POST bodies (strict zod, anything else is 400):

| Body | Effect |
| --- | --- |
| `{ intel?: boolean }` | Start a run (or return the user's active one). Refused after 3 runs a day (429). |
| `{ runId, expectStep }` | Do one step. If the run is not `running` or `step != expectStep`, nothing happens and the current status returns. |
| `{ runId, action: 'approve', queries: (string \| {q, why?})[1..3] }` | Pass gate 1 with the edited queries (trimmed, de-duplicated, 120 chars). |
| `{ runId, action: 'select', key }` | Pass gate 2; response is the status plus `jobText` for the tailor. |
| `{ runId, action: 'cancel' }` | Cancel; a no-op if already terminal. |

GET: `?runId=` returns `{ run }` (404 if not the caller's), no id returns the latest active run or `{ run: null }`, `?credits=1` returns the credit status. When `radar_enabled` is off the route answers with a "paused for maintenance" message.

Status shape: `{ runId, status, phase, step, totalSteps, message, gate, events, state, creditsUsed, mode, error }`. Posting descriptions are cut to 300 characters in polls; the full text stays server-side for `select`.

The client loops: POST `{runId, expectStep: status.step}` until the status is `awaiting` or terminal. Every successful step bumps `step`.

### What each step does

| Phase | Work | Bound |
| --- | --- | --- |
| plan | One fast model call (3-call, 20k-token budget, 6.5 s), rules-only fallback from role titles | one request |
| search | Submit every approved query to `google_jobs` with `async=true`, in parallel. Credits reserved and ledger row written before each call; search id stored right after | each HTTP call <= 8 s |
| poll | One bounded GET of the Search Archive per pending search, then a pause of up to 2.5 s. Repeats until all settle. A search still pending 60 s after its submit is warned and skipped | each GET <= 8 s |
| rank | Deterministic ranking, top 5, market signal, pick up to 2 companies for intel | milliseconds |
| intel | Per company, in parallel: `google_jobs_listing` plus `google_news`, then a Google `reviews` search as the rating fallback. 3 credits reserved per company, settled to what was billed | each call <= 8 s, step <= 16 s |
| select | Gate 2; `select` returns the posting text | n/a |

Each `advanceRadar` claims the step with a lease (`leased_until`, `attempts` incremented in SQL) so two tabs cannot both do the work or spend the credits; the lease outlives a legitimately running step (45 s) and is only reclaimed after that. A step claimed more than 6 times fails the run. Unexpected errors retry up to 3 times, then the run errors with an authored message. A run nobody advances is cancelled after 10 minutes (60 minutes when it is waiting at a gate).

## SerpApi behaviour (verified live 2026-10-08)

- Async submit returns `search_metadata.id` with status `Processing` in about 300 ms.
- Reading the Search Archive is free; it honours `json_restrictor`; the result is `Success` after about a second.
- A search is billed 1 credit once it completes. A search that returns "hasn't returned any results" is an empty answer and is still billed; it is cached for 10 minutes as `_empty`.
- `google_jobs_listing` returns nothing for most postings, so ratings come from a Google `reviews` search, labelled `<Site> (via Google)`.
- News uses a quoted company query plus a company filter on the results.
- Credit state is `ok`, `blocked` (fewer than 10 searches left or 45 attempts in the hour: answer from fixtures, labelled) or `unavailable` (the guard's own storage is down: "temporarily unavailable", never fixtures).
- The daily run cap resets at midnight IST (18:30 UTC).

## Agent roster

| Agent | Kind | Notes |
| --- | --- | --- |
| Planner | LLM, 1 fast call, rules fallback | Queries from roles, skills, city; on any failure uses a plan built from role titles |
| Searcher | Code | `google_jobs`, page 1, async; dedupe by sha1(title, company); job ids are not trusted as identity |
| Ranker | Code, deterministic | Skill lexicon plus the quality gate's matcher; top 5; never imports the AI layer |
| Employer-Intel | Code | News, listing and rating fallback for the top 2 companies; opt-out per run |
| Market-Signal | Code | Salary p25 / median / p75 in LPA, top skills, gap skills |
| Tailor | Existing pipeline | Fit check, grounded rewrite with the posting text as input |
| Critic | Existing loop | 8.5 score bar, up to 4 passes; the evidence grader takes two votes at different temperatures and keeps the lower grade per line |

## Guardrails

- **Grounding:** the tailor's grounding guard rejects any rewrite with a number or proper noun not in the user's records. Radar adds no model-written claims about the user.
- **Budgets:** 3 runs per user per day and 12 credits per run (a call is skipped with a warning when it would exceed the cap), counted from SQL reservations so a failed or killed run still counts; 1 h / 24 h cache; block below 10 searches left or at 45 attempts in the hour; low-credit alert at `SERP_LOW_CREDITS` (default 25); planner under the daily AI allowance. A draft is capped at `MAX_AI_CALLS_PER_DRAFT` (default 40) calls.
- **Caps:** at most 3 queries, 30 postings kept, 120-character queries, 60 events.
- **Idempotency:** each commit is `UPDATE ... WHERE id AND step = expectStep AND status IN (...)`; a lost race returns whatever won. Single-flight shares one upstream search between identical concurrent requests.
- **Approval gates:** queries before any credit is spent; posting selection before handoff. Never auto-applies.
- **Isolation:** every read and write includes the session's user id; foreign runs return 404.
- **Privacy:** only role, skill and city text reaches SerpApi.
- **Key handling:** server-only, scrubbed from error strings, URLs never logged, user-visible messages are authored by the app.
- **Honesty about data:** replay results are labelled sample data; a block mid-run flips the run to replay with a warning event.
- **Kill switch:** `radar_enabled` (at `/admin/flags`, or env `FLAG_RADAR_ENABLED=false`) stops new radar requests without a deploy.

## Draft requests (the tailor)

`POST /api/draft` carries an `Idempotency-Key` header minted per attempt by the browser. A new key claims a `draft_run` row; a key whose draft finished replays that snapshot without running anything; a key still running (under 90 s old) returns 409 and the client polls `GET /api/draft/status?key=`; a failed or stale run is retired and taken over. A draft that dies after producing a resume is salvaged (the early-persisted snapshot is returned) and the housekeeping reaper closes unfinished runs.

## Latency (measured live, 2026-10-08)

| Phase | Time |
| --- | --- |
| plan | 1.3 s |
| search (submit) | 0.7 s |
| poll | 1.25 s |
| rank | 1.7 s |
| intel | 11.8 s |

The longest single HTTP call was 6.1 s and the stored run state was about 55 KB. Netlify free kills a function at about 30 s, so each request is one short unit of work and state lives in Postgres between requests; a run survives refreshes and cold starts. The route sets `maxDuration = 60` (honoured on Vercel, ignored on Netlify). Replay fixtures are read from disk and included in the build via `outputFileTracingIncludes` for `/api/radar`.

## Failure modes

| Failure | Result |
| --- | --- |
| Planner model fails | Rules-only plan from role titles |
| Empty profile (no queries possible) | Run ends in error with an instruction to add a role or skill |
| One search or company fails or times out | Warning event, skipped |
| A search still pending after 60 s | Warning event, skipped |
| Every search fails | Run ends in error |
| No key, `SERP_MODE=replay`, credits low, hourly cap | Replay on synthetic fixtures, banner shown |
| Credit guard storage down | "Temporarily unavailable"; no fixtures presented as live |
| No listing rating | Google `reviews` fallback; otherwise unknown, headlines still shown |
| Cache unreadable or unwritable | Treated as a miss, call proceeds |
| `account.json` unreachable | Monthly figure unknown, hourly count still binds |
| Two tabs advance one run | One wins the lease; the other receives the winner's status |
| Step worker killed mid-step | Lease expires, step reclaimed; the ledger prevents a second submit; 6 claims fail the run |
| Step throws | Retried up to 3 times, then `error` with an authored message; details only in server logs |
