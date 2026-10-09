# Runbook (solo owner)

One page. Longer reference: `docs/production/OPERATIONS.md`. Health: `GET /api/health` (200 `{"status":"ok"}`; add header `x-cron-secret: <CRON_SECRET>` for detail).

## Deploy and roll back

- Deploys: push to `main` -> Netlify builds (`npm run build`). CI (`.github/workflows/ci.yml`) must be green first: types, lint, tests, build, audit, gitleaks.
- **Roll back**: Netlify -> Deploys -> pick the last good deploy -> **Publish deploy**. Instant, no rebuild. Database changes are NOT rolled back by this; SQL scripts are additive (see below), so the old code keeps working against the new schema.
- Verify any deploy: `curl -s https://<site>/api/health` -> `{"status":"ok"}`; detail check: `curl -s -H "x-cron-secret: $CRON_SECRET" https://<site>/api/health | jq '.env,.db,.deep'` (`env.ok` true, `deep.tables` all true, `stuckRadarRuns` 0).

## Database (Neon)

- **Apply schema changes**: run `scripts/*.sql` in filename order (each is idempotent: `IF NOT EXISTS`), e.g. `psql "$DATABASE_URL" -f scripts/2026-10-08-draft-idempotency.sql` (the latest; the full list and order are in `docs/production/OPERATIONS.md` section 4, and the code that uses a file must not be deployed before it is applied) (use the *direct*, not pooled, URL for DDL). `npm run db:push` also works for a throwaway database; never run it against production without reading its diff. **Versioned migrations now exist** (`drizzle/`, baseline `0000_baseline`; production was marked at baseline on 2026-10-08): change the schema, run `npm run db:generate`, commit the generated SQL, apply with `npm run db:migrate` (check with `npm run db:migrate:status`), never edit an applied file. `tests/db-migrations.test.mts` fails if the schema and `drizzle/` disagree. The `scripts/*.sql` files above are the pre-migration history; do not apply them to a database created with `db:migrate`.
- **Restore (point in time)**: Neon console -> project -> Branches -> **Restore** -> choose the timestamp (history window is plan-dependent, 6h on free) -> restore to a *new branch first* (e.g. `restore-check`), verify, then either point `DATABASE_URL` at it in Netlify env vars and redeploy, or restore the main branch in place.
- **Restore drill (do quarterly, 20 minutes)**: 1) create a branch from "5 minutes ago"; 2) connect with `psql`, run `select count(*) from "user"; select count(*) from draft_run;`; 3) compare with production counts; 4) point a *preview deploy's* `DATABASE_URL` at the branch, sign in, open /profile; 5) delete the branch; 6) write the date and result at the bottom of this file.
- Retention runs daily (`/api/cron/housekeeping`); see OPERATIONS.md for what is deleted when.

## Secrets rotation (Netlify -> Site settings -> Environment variables, then redeploy)

| Secret | Rotate when | What breaks while/after |
|---|---|---|
| `TOKEN_ENC_KEY` | leaked / yearly | Stored GitHub tokens and fit-check tokens become unreadable: users sign in again; in-flight drafts fail their fit check once. |
| `AUTH_SECRET` | leaked / yearly | Every session is invalidated: everyone signs in again. |
| `CRON_SECRET` | leaked | Doorbells get 401 until the redeploy picks up the same value (they read it from the same env). |
| Provider keys (`GROQ_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, ...) | leaked / provider notice | That provider's calls fail and the chain falls through to the next; none set = no drafts. Revoke the old key at the provider. |
| `SERPAPI_API_KEY` | leaked | Radar drops to replay mode (fixtures) until updated. |
| `GITHUB_APP_PRIVATE_KEY` | leaked | Repo access via the App stops until the new `.pem` is set; generate it in GitHub App settings first, then swap, then delete the old key. |
| `AUTH_GITHUB_SECRET` / Google secret | leaked | OAuth sign-in for that provider fails until updated. |
| `SMTP_PASS` (Gmail app password) | leaked | No verification, reset or approval emails. Create a new app password, set it, delete the old one. |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` | leaked | Error reports / source-map upload stop. |

## Kill switches

- **Owner page `/admin/flags`** (owner session only): `radar_enabled`, `ai_enabled`, `signups_enabled`, `maintenance_message`. Takes effect within ~15 s per instance; every change is in `audit_log` (`action = 'flag-set'`).
- **Env override** (works with the DB down): `FLAG_RADAR_ENABLED=false`, `FLAG_AI_ENABLED=false`, `FLAG_SIGNUPS_ENABLED=false`, `FLAG_MAINTENANCE_MESSAGE=...`; redeploy to apply.
- **One provider**: `AI_DISABLED_PROVIDERS=groq` (comma list) takes just that provider out of the chain.
- **Radar only, no deploy**: `SERP_MODE=replay` forces fixtures (no SerpApi spend).
- **Wiring status**: enforced. `radar_enabled` is checked by the radar handlers (`lib/radar/handlers.ts`), `ai_enabled` in the AI daily-budget check (`lib/ai/daily-budget.ts`), `signups_enabled` in sign-up and invite redemption. A settings-table read error fails open to the default (a broken table never takes the product down), so use the env override when the database itself is the problem.

## Incident checklist

1. `curl /api/health` (public). 503 = database unreachable: check Neon status/console, connection limits, `DATABASE_URL`.
2. Detail check (above): `env.missing`, `deep.tables`, `deep.stuckRadarRuns`, `deep.heartbeats` (when did each cron last run), `deep.serp.creditsLeft`.
3. Sentry -> Issues (sorted by last seen, environment = production). Netlify -> Logs -> Functions: JSON lines, filter `"level":"error"`.
4. Bad deploy? Roll back first (Publish deploy of the previous one), investigate second.
5. Provider outage? Check `deep.models` / cooldowns; flip `AI_DISABLED_PROVIDERS` or `ai_enabled` if everything is failing.
6. Spend spike? Turn off `radar_enabled` / `ai_enabled`, check `ai_usage_daily` and SerpApi dashboard.
7. Leaked secret? Rotate per the table above, then redeploy, then check Sentry for events carrying it (they are scrubbed, but check).
8. Write down: what, when, fix, follow-up.

## Monitoring setup

- **UptimeRobot** (free): HTTP(s) monitor on `https://<site>/api/health`, 5-minute interval, keyword `"status":"ok"`, alert contact = your email/phone.
- **Healthchecks.io** (free): create checks `draft-alerts` (period 1h, grace 15m), `housekeeping` (1 day, grace 2h), `daily-sync` (1 day, grace 2h). Set Netlify env `HEARTBEAT_URL_DRAFT_ALERTS`, `HEARTBEAT_URL_HOUSEKEEPING`, `HEARTBEAT_URL_DAILY_SYNC` to each ping URL (or one `HEALTHCHECKS_BASE_URL=https://hc-ping.com/<project-ping-key>` and name the checks by slug). The functions ping on 2xx and `/fail` otherwise.
- **Sentry** alert rules (Project -> Alerts): see OPERATIONS.md "Sentry alert rules".
- Emails go to `ALERT_EMAIL`: draft failures hourly; credits low (< `SERP_LOW_CREDITS`, default 25), stuck radar runs, database down - each at most once per 24 h per condition.

## Capacity limits

| Resource | Limit (free tier, check current plan) | Guard in the app |
|---|---|---|
| SerpApi | 250 searches/month, 50/hour | `lib/serp/budget.ts` blocks below 10 left or at 45 searches in an hour and drops to replay (labelled); if the guard's storage is down radar says "temporarily unavailable"; email alert below 25 left; an empty search is still billed |
| Groq / Gemini free | per-minute and per-day token limits (provider dashboard) | provider chain + cooldowns; `APP_DAILY_MAX_CALLS` (2000) / `APP_DAILY_MAX_TOKENS`; `MAX_AI_CALLS_PER_DAY` (400/user) |
| Neon free | storage ~0.5 GB, compute auto-suspends (cold start ~0.5-2 s), connection cap | retention sweep; pooled URL; `max: 5` connections per instance |
| Netlify free | functions 10 s (scheduled 30 s), 125k invocations/mo, 100 GB bandwidth, 300 build min | `MAX_DRAFT_SECONDS` 20 s clock; doorbell pattern |
| Gmail SMTP | ~500 messages/day | email is low volume; alert emails de-duplicated |

## Contact

Owner: Anand Sundaramoorthy (jothianandanand036@gmail.com). Vendors: Neon (neon.tech status), Netlify (netlifystatus.com), Sentry, SerpApi, Groq, Google AI.

## Restore-drill log

**2026-10-09** → **PITR drill done** (first run). Created branch `pitr-drill-2026-10-09` from `production` restored to a past point-in-time (the free create-branch form offers "from a past point in time"; the picker's earliest bound is the effective window and a deeper restore needs a paid plan). Verified the restored branch matched production reference counts — user = 3, latest draft = 2026-09-11T23:01:13Z, agent_run = 1 — then deleted the branch. No prod changes, no downtime. Reference query set: `count(*) from "user"`, `max(started_at) from draft_run`, `count(*) from agent_run`.
