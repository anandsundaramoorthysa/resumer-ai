# Operations reference

Companion to `RUNBOOK.md` (the one-page procedures). This is the reference: environment matrix, scheduled jobs, retention, SQL order, Sentry rules, dashboard queries.

## 1. Environment matrix

Validated by `validateEnv()` in `lib/env.ts` (zod; returns names only, never throws, never runs at import). `GET /api/health` with the cron secret returns it under `env`.

| Variable | Class | If missing |
|---|---|---|
| `DATABASE_URL` | **required** | no app (setup screen) |
| `AUTH_SECRET` | **required** | no sign-in |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | **required** | no sign-in / repo sync |
| `TOKEN_ENC_KEY` | **required** | fit check fails, no drafts |
| `NEXT_PUBLIC_SITE_URL` | **required** | wrong canonical/sitemap/links |
| one of `GROQ_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `FIREWORKS_API_KEY`, `TOGETHER_API_KEY`, `DEEPINFRA_API_KEY` | **required (at least one)** | no AI |
| `CRON_SECRET` | optional (warns) | every scheduled job and the health detail refuse |
| `ALERT_EMAIL`, `SMTP_USER`, `SMTP_PASS` | optional (warns) | no alert / verification / approval emails |
| `OWNER_EMAILS` | optional (warns) | nobody can open `/admin/*` |
| `NEXT_PUBLIC_SENTRY_DSN` (+ `SENTRY_AUTH_TOKEN` at build) | optional | no error reports / source maps |
| `SERPAPI_API_KEY` | optional | radar runs in replay mode |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | optional | OAuth `repo` scope instead of the App; no push webhooks |
| `FIRECRAWL_API_KEY` | optional | no page scraping fallback |

Also optional: `SIGNUP_MODE` (`invite` default | `open` | `manual`), `AUTO_APPROVE_DAILY_QUOTA` (default 20 per IST day), `SERP_MODE` (`replay` | `live` | `record`), `RADAR_PUBLIC_DEMO` (`1` allows `/radar?demo=1` in production), `AI_DISABLED_PROVIDERS`, `AI_PII_PROVIDERS`, `AI_BREAKER_THRESHOLD` (3), `AI_BREAKER_OPEN_MS` (30000), `AI_MODEL_GONE_COOLDOWN_MS` (6 h), `AI_DEFAULT_MAX_OUTPUT_TOKENS` (4000), `MAX_AI_CALLS_PER_DRAFT` (default 40). `.env.example` lists every variable.

Also optional: `FLAG_<KEY>` (kill-switch overrides), `HEARTBEAT_URL_DRAFT_ALERTS|HOUSEKEEPING|DAILY_SYNC` or `HEALTHCHECKS_BASE_URL`, `SERP_LOW_CREDITS` (default 25), `LOG_LEVEL` (debug|info|warn|error, default info), `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` (default 0), `COMMIT_REF` / `CONTEXT` (set by Netlify; used as Sentry release/environment).

## 2. Scheduled jobs (UTC)

| Function (`netlify/functions`) | Schedule | Route it rings | Does |
|---|---|---|---|
| `draft-alerts.mts` | `5 * * * *` | `/api/cron/alerts` | failed-draft email; ops alerts (credits low, stuck radar runs, DB down; 24 h de-dupe); light purge (auth attempts/tokens, sync jobs) |
| `housekeeping.mts` | `30 3 * * *` | `/api/cron/housekeeping` | full retention sweep (section 3); `?scope=hourly` = light pass |
| `daily-sync.mts` | `15 4 * * *` | `/api/cron/sync` | portfolio SHA freshness check |

All are doorbells: one authenticated request (`x-cron-secret`), always HTTP 200 so Netlify does not retry, then an optional heartbeat ping. Each route records `hb:<name>` in `app_setting`; `/api/health` detail shows `deep.heartbeats`.

## 3. Retention

| Data | Kept | Implementation |
|---|---|---|
| `draft_run` | 90 days | batched delete by `started_at` |
| `agent_run` (+ `radar_search` cascade) | 30 days, terminal runs only | `lib/radar/housekeeping.ts` `pruneRadarData` |
| `serp_cache` | 24 h (30 d absolute max) | same module |
| denied accounts | 30 days after the decision; owners never | batched `delete from "user"` (cascades) |
| inactive accounts | 24 months with notice | **report only**: `selectInactiveAccounts()` -> `inactiveAccounts` in the housekeeping response. Nothing is deleted. Process: review the list, email a notice, wait 30 days, delete by hand. |
| `audit_log` | 12 months | batched delete |
| `audit_log.diff.prompt` | nulled after 90 days | `jsonb_set(diff,'{prompt}','null')`, idempotent |
| `ai_call` | 90 days | `pruneAiCalls` (`lib/ai/telemetry.ts`) |
| `auth_attempt` | 2 days | existing purge |
| `auth_token` | 7 days past expiry | existing purge |
| `sync_job` | 7 days (never `running`); failed-job corpus cleared | existing logic |

Every delete is `delete ... where id in (select id ... limit 500)` in a loop sharing an 8 s budget; a run cut short reports `more: true` and continues next day. Re-running is safe. Radar and ai_call steps are `import()`-guarded: absent module = skipped.

## 4. SQL apply order

Filename order, each idempotent, direct (non-pooled) connection:

1. `2026-09-12-dismissed-record.sql`
2. `2026-09-12-enrichment-preference.sql`
3. `2026-10-06-job-radar.sql` (`agent_run`, `serp_cache`, `radar_search`)
4. `2026-10-07-ai-call-telemetry.sql`
5. `2026-10-07-consent-invites.sql`
6. `2026-10-07-ops-indexes-flags.sql` (4 indexes + `app_setting`)
7. `2026-10-07-radar-reliability.sql` (`agent_run.attempts`, `radar_search`; a no-op if file 3 was applied from its current copy)
8. `2026-10-08-draft-idempotency.sql` (`draft_run.idempotency_key` + partial unique index)

Apply each file before deploying the code that uses it (the draft route reads `idempotency_key`, so file 8 must be in place first).

Base tables come from `npm run db:push` on first setup. Verified: the script run on a schema built from `lib/db/schema.ts` produces identical index definitions and `app_setting` columns (no drift) and is a no-op on re-run. Indexes are plain btrees (Drizzle cannot express `INCLUDE`; `(day, calls, tokens)` gives the same index-only scan).

## 5. Sentry alert rules (create in the Sentry UI)

Environment filter on all: `production`.

1. **New issue**: when a new issue is created -> email. (Everything first-seen is worth a look at this scale.)
2. **Regression**: when an issue changes state from resolved to unresolved -> email.
3. **Spike**: issue seen more than 10 times in 1 hour -> email.
4. **Draft pipeline errors**: issues where `message` or `culprit` contains `draft` or `all-providers-failed`, more than 3 events in 15 minutes -> email.
5. **Release health** is not used (no sessions); traces are off (`tracesSampleRate` 0).
6. Weekly digest on; ignore noisy known errors by *fingerprint*, not by silencing the project.

What is sent: errors only, `sendDefaultPii: false`; request bodies, cookies, auth headers and query strings are removed; exception messages truncated to 300 characters; emails, phone numbers, bearer/api-key/long tokens redacted (`sanitizeEvent`, `lib/sentry-options.ts`). Replay/tracing helpers are excluded from the bundle (`bundleSizeOptimizations`).

## 6. Logging

`lib/log.ts`: one JSON line per event (`ts, level, msg, requestId, route, userId (hashed), err`), scrubbed with the same redactor as Sentry. Adopted in the health route, cron routes and the Netlify functions. **Codemod note**: ~100 bare `console.error/warn` calls remain across `app/` and `lib/`; migrate file by file to `log.error('what failed', { err })`. `log.error` does not go to Sentry by itself, whereas `console.error` does via `captureConsoleIntegration` - add `Sentry.captureException(err)` where an alert is wanted. Wrap request handlers in `withRequestId(id, fn)` to correlate lines.

## 7. Dashboard queries (run in the Neon SQL editor)

Draft success rate, last 30 days, by day:

```sql
select date_trunc('day', started_at)::date as day,
       count(*) filter (where status = 'success') as ok,
       count(*) filter (where status = 'failed')  as failed,
       round(100.0 * count(*) filter (where status = 'success') / nullif(count(*), 0), 1) as success_pct,
       percentile_cont(0.5) within group (order by duration_ms) as p50_ms,
       percentile_cont(0.95) within group (order by duration_ms) as p95_ms
from draft_run
where started_at > now() - interval '30 days'
group by 1 order by 1 desc;
```

Failure causes, last 7 days:

```sql
select coalesce(error_kind, 'unknown') as kind, count(*) from draft_run
where status = 'failed' and started_at > now() - interval '7 days'
group by 1 order by 2 desc;
```

Radar run outcomes and credit burn, last 30 days:

```sql
select status, mode, count(*) as runs, sum(credits_used) as credits,
       round(avg(extract(epoch from (updated_at - created_at)))) as avg_seconds
from agent_run
where created_at > now() - interval '30 days'
group by 1, 2 order by runs desc;
```

Stuck radar runs now:

```sql
select id, user_id, status, phase, now() - updated_at as idle
from agent_run
where status in ('running','awaiting') and updated_at < now() - interval '30 minutes';
```

Today's AI spend: `select sum(calls) calls, sum(tokens) tokens from ai_usage_daily where day = to_char(now() at time zone 'utc','YYYY-MM-DD');`

Provider reliability (needs `ai_call`): `select provider, count(*) calls, count(error_class) errors, round(avg(latency_ms)) avg_ms from ai_call where created_at > now() - interval '7 days' group by 1;`

Suggested SLOs: draft success >= 90 % (30 d); radar run completion >= 95 %; `/api/health` availability >= 99.5 %.

## 8. CI

`.github/workflows/ci.yml`: least-privilege token, concurrency cancel-in-progress, job timeouts, `npm audit --omit=dev --audit-level=critical` blocking plus a non-blocking `high` report, and a gitleaks job (official action, pinned to a release; commit-SHA pin is stricter). `.github/dependabot.yml`: npm weekly (minor/patch grouped), actions monthly. `.nvmrc` = 22.

## 9. Known limits

- **INTEL_REBILL (radar):** a killed or overlapped intel step re-calls SerpApi for any lookup it had not cached yet. The credit reservation (`radar_search` ledger) is idempotent; per-call completion is not stored. Worst case is a few extra credits on a rare crash.
- **Naive timestamps:** `agent_run.created_at/updated_at` and `serp_cache.fetched_at` are `timestamp` (no time zone) and are compared against UTC values written from JS. This assumes the database session time zone is UTC (true on Neon); a non-UTC session would skew stale-run and retention cutoffs.
