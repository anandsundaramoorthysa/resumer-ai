# Job Radar architecture

Principle: code decides and fetches; a model runs only where language is needed (the planner, and the existing tailor and critic).

## Components

| Piece | Where | Role |
| --- | --- | --- |
| API route | `app/api/radar/route.ts` | Session auth, burst limit, request validation; one call per step |
| Orchestrator | `lib/radar/runs.ts` | Run state machine, gates, compare-and-set commits |
| Events and bounds | `lib/radar/events.ts` | Event list (capped at 60), run state shape, safe messages |
| Planner / Ranker / Market | `lib/radar/{planner,ranker,market}.ts` | Pure agents |
| SerpApi layer | `lib/serp/{client,budget,normalize,salary,fixtures,types}.ts` | Fetch, cache, guards, parsing, replay |
| Tables | `lib/db/schema-radar.ts` | `agent_run`, `serp_cache` |
| UI | `app/radar/page.tsx`, `components/radar/*` | Timeline, gates, results; `?demo=1` is scripted client-side sample data |
| Handoff | `components/draft-console.tsx` | Takes job text from the chosen posting (sessionStorage keys `radar:jobText`, `radar:jobLabel`) and skips URL scraping |

## Data model

- `agent_run`: `id`, `user_id` (cascade), `status` (running | awaiting | done | error | cancelled), `phase`, `step`, `total_steps`, `message`, `state` jsonb (plan, queries, postings, ranked, intel, market, selectedKey, gate), `events` jsonb (append-only, capped 60), `credits_used`, `mode` (live | replay), `error`, timestamps. Index on `(user_id, created_at)`.
- `serp_cache`: `key` = sha256(engine + sorted params without `api_key`/`no_cache`), `engine`, `payload` jsonb, `fetched_at`. It also holds the `account.json` memo (engine `account`), which the hourly count excludes.

## Run state machine

```
plan -> awaiting-queries -> search -> rank (+market) -> intel -> select -> done
          (gate 1)           (all queries, parallel)   (parallel)  (gate 2)
```

`error` and `cancelled` are the other terminal states. Gates set `status = awaiting` with `state.gate` of `queries` or `select`.

The repository's orchestrator is being changed to this phase list; before that change it ran one search or one company per step in sequence. The protocol below is the same either way.

## Protocol (`/api/radar`, JSON, `Cache-Control: no-store`, session required)

POST bodies (strict zod, anything else is 400):

| Body | Effect |
| --- | --- |
| `{ intel?: boolean }` | Start a run (or return the user's active one). Refused after 3 runs a day (429). |
| `{ runId, expectStep }` | Do one step. If the run is not `running` or `step != expectStep`, nothing happens and the current status returns. |
| `{ runId, action: 'approve', queries: (string \| {q, why?})[1..3] }` | Pass gate 1 with the edited queries (trimmed, de-duplicated, 120 chars). |
| `{ runId, action: 'select', key }` | Pass gate 2; response is the status plus `jobText` for the tailor. |
| `{ runId, action: 'cancel' }` | Cancel; a no-op if already terminal. |

GET: `?runId=` returns `{ run }` (404 if not the caller's), no id returns the latest active run or `{ run: null }`, `?credits=1` returns `{ left, hourUsed, mode }`.

Status shape: `{ runId, status, phase, step, totalSteps, message, gate, events, state, creditsUsed, mode, error }`. Posting descriptions are cut to 300 characters in polls; the full text stays server-side for `select`.

The client loops: POST `{runId, expectStep: status.step}` until the status is `awaiting` or terminal. Every successful step bumps `step`.

## Agent roster

| Agent | Kind | Notes |
| --- | --- | --- |
| Planner | LLM, 1 fast call (small budget, 6.5 s), rules fallback | Queries from roles, skills, city; on any failure uses a plan built from role titles |
| Searcher | Code | `google_jobs`, page 1, dedupe by sha1(title, company); job ids are not trusted as identity |
| Ranker | Code, deterministic | Skill lexicon plus the quality gate's matcher; top 5; never imports the AI layer |
| Employer-Intel | Code | `google_jobs_listing` ratings + `google_news` for the top 2 companies; opt-out per run |
| Market-Signal | Code | Salary p25 / median / p75 in LPA, top skills, gap skills |
| Tailor | Existing pipeline | Fit check, grounded rewrite with the posting text as input |
| Critic | Existing loop | 8.5 score bar, up to 4 passes |

## Guardrails

- **Grounding:** the tailor's grounding guard rejects any rewrite with a number or proper noun not in the user's records. Radar adds no model-written claims about the user.
- **Budgets:** 3 runs per user per day, 12 credits per run (a step is skipped with a warning when the next call would exceed it), 1h / 24h cache, block below 10 searches left or at 45 stored live searches in the hour, 6 s timeout per SerpApi call, planner under the daily AI allowance and a 3-call cap.
- **Caps:** at most 3 queries, 50 postings kept, 120-character queries, 60 events.
- **Idempotency:** each commit is `UPDATE ... WHERE id AND step = expectStep AND status IN (...)`; a lost race returns whatever won. Stale or duplicate requests do no work.
- **Approval gates:** queries before any credit is spent; posting selection before handoff. Never auto-applies.
- **Isolation:** every read and write includes the session's user id; foreign runs return 404.
- **Privacy:** only role, skill and city text reaches SerpApi.
- **Key handling:** server-only, scrubbed from error strings, URLs never logged, user-visible messages are authored by the app.
- **Honesty about data:** replay results are labelled sample data; a block mid-run flips the run to replay with a warning event.

## Latency budget

Netlify free kills a function at 30 s, so each request is one short unit of work: a SerpApi call is capped at 6 s, the planner at about 6.5 s, and pure steps take milliseconds. State lives in Postgres between requests, so the run survives refreshes and cold starts. The route sets `maxDuration = 60` (honoured on Vercel, ignored on Netlify). Replay fixtures are read from disk and included in the build via `outputFileTracingIncludes` for `/api/radar`.

## Failure modes

| Failure | Result |
| --- | --- |
| Planner model fails | Rules-only plan from role titles |
| Empty profile (no queries possible) | Run ends in error with an instruction to add a role or skill |
| One search or company fails or times out | Warning event, skipped |
| Every search fails | Run ends in error, "nothing was spent beyond this run" |
| No key, `SERP_MODE=replay`, credits low, hourly cap | Replay on synthetic fixtures, banner shown |
| No listing rating | Rating 0 (unknown), headlines still shown |
| Cache unreadable or unwritable | Treated as a miss, call proceeds |
| `account.json` unreachable | Monthly figure unknown, hourly count still binds |
| Two tabs advance one run | One wins; the other receives the winner's status |
| Step throws | Run moves to `error` with an authored message; details only in server logs |
