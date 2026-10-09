# Alerting, monitoring and DR runbook

External-provider hardening that has no runtime code in this repo: heartbeat checks, an uptime monitor, a Neon point-in-time-restore drill, and the Sentry alert rules. Everything below is a **dashboard action** on external accounts - none of it can be done from this repository alone. What the repo already provides (code and endpoints) is listed first so the manual work is only the account side.

Current state (verified live 2026-10-09, commit `6f541ed`):

- **Done, app-side:** `/api/health` answers 200; the three Netlify scheduled functions (`draft-alerts` `5 * * * *`, `housekeeping` `30 3 * * *`, `daily-sync` `15 4 * * *` UTC) are doorbells that call `pingHeartbeat` (`lib/log.ts:122`) on every run, including `/fail` on failure; `?dryRun=1` on `/api/cron/alerts` returned 200 with one finding and sent no email.
- **Not set, provider-side:** none of `HEARTBEAT_URL_DRAFT_ALERTS`, `HEARTBEAT_URL_HOUSEKEEPING`, `HEARTBEAT_URL_DAILY_SYNC`, `HEALTHCHECKS_BASE_URL` exist on Netlify (check: `netlify env:list --json`); no external uptime monitor polls `/api/health`; no Neon PITR drill has been run; no Sentry alert rule is configured. `SENTRY_AUTH_TOKEN` is unset (source-map uploads only - not needed for alerting).

## Prereq: the cold-start caveat (read once)

Neon free suspends an idle database; the first `/api/health` probe after idle pays the resume and returns 503 `{"status":"degraded"}`. Every monitor below must therefore use **two consecutive failures** before alerting, or an interval short enough that a 503 (resume) or 200 (warm) is fine either way. See `OPERATIONS.md` §9. Do not set a monitor to alert on the first non-200.

## 1. Heartbeat checks (dead-man's switch for the three cron jobs)

Provider: **Healthchecks.io** (free) is the best fit because the repo already follows its convention (`/fail` on failure). BetterStack heartbeats work too but have no fail-endpoint convention - a missed ping is the only signal there.

1. Sign up at healthchecks.io (free plan covers 20 checks) and set the **Integrations** email to `ALERT_EMAIL` (`sanand03072005@gmail.com`).
2. Create three checks, period = the schedule, grace large enough that a Netlify deploy tick or cold function start does not page:

   | Check | Period | Grace |
   |---|---|---|
   | `draft-alerts` | 60 m | 360 m |
   | `housekeeping` | 1440 m (24 h) | 90 m |
   | `daily-sync` | 1440 m (24 h) | 90 m |

   Schedules are UTC; leave the check timezone at UTC or any timezone - only the cadence matters.
3. Copy the **Ping URL** of each check.
4. In Netlify: Site > Configuration > Environment variables. Add, with scope **All** (Builds, Functions, Runtime):

   ```
   HEARTBEAT_URL_DRAFT_ALERTS=<ping-url>
   HEARTBEAT_URL_HOUSEKEEPING=<ping-url>
   HEARTBEAT_URL_DAILY_SYNC=<ping-url>
   ```

   (Optional single-var alternative: set only `HEALTHCHECKS_BASE_URL` to the ping URL root; `lib/log.ts` appends `/<name>` and `/fail`.)
5. Redeploy production (env changes apply on the next build): push to `main` (CI runs, Netlify builds) or Netlify > Deploys > Trigger deploy > Clear cache and deploy site.
6. Verify without waiting for the clock:
   - Ring each route yourself with the cron secret; the function sends the ping then the route answers:
     `Invoke-WebRequest -Uri 'https://resumeraiapp.netlify.app/api/cron/alerts' -Headers @{'x-cron-secret'=...}`
   - Healthchecks.io should show a green ping with timestamp seconds ago for `draft-alerts`.
   - Confirm `hb:` rows are recorded: `GET https://resumeraiapp.netlify.app/api/health` with `x-cron-secret` shows `deep.heartbeats`.
7. Confirm a **missed** ping alerts: Healthchecks flip-alert to email is on by default; you can also check one check's "grace" behavior by toggling its status from the API during the drill.

## 2. External uptime monitor on `/api/health`

Provider: UptimeRobot free or a second Healthchecks.io HTTP check. BetterStack = paid.

- URL: `https://resumeraiapp.netlify.app/api/health`
- Expect: HTTP 200. Treat 503 as "down only if it repeats".
- Interval: 10-15 min. Anything tighter defeats Neon's scale-to-zero and spends the free compute-hour budget on probes.
- **Two consecutive failures** before alerting (cold-start 503 - prereq above). UptimeRobot "Trigger count: 2".
- Alert channel: email to `ALERT_EMAIL`.
- The endpoint needs no auth, so the monitor needs no secret. `x-cron-secret` is only for the health *detail* view.

## 3. Neon point-in-time restore (PITR) drill

1. Confirm the window: Neon console > project > Settings > Storage/restore. Free plan = 6 h history; paid plans allow longer. If the window were 0, `db:push`-era renames and any bad migration after the last 6 h could not be rolled back - this drill proves the branch flow works.
2. Drill (repeat quarterly; ~10 min):
   - Branches > Create branch, name `pitr-drill-<yyyy-mm-dd>`, "origin" = the production branch, point in time = a few minutes ago.
   - Wait for the branch to finish provisioning (green). Copy the branch connection string (same password model as production).
   - Connect (e.g. `psql` or Neon SQL editor opened on the branch) and sanity-check:
     `select count(*) from "user";` and `select max(created_at) from draft_run;` - compare roughly to what production must have looked like at that time.
   - Delete the branch. Confirm deletion frees the storage.
3. Record the drill: date, rows seen, result. The point is that the *restore path works before you ever need it*, not that the data is meaningful.
4. Owner note: this needs Neon console access (or a Neon API token). No token is stored anywhere in this repo or repo env, so it stays a manual dashboard task.

## 4. Sentry alert rules (OPERATIONS.md §5, unchanged)

All rules: environment filter = `production`. Create in Sentry > Alerts > Create alert.

1. **New issue** -> email: when a new issue is created, alert. (Everything first-seen is worth a look at this scale.)
2. **Regression** -> email: issue changed resolved -> unresolved.
3. **Spike** -> email: issue seen more than 10 times in 1 hour.
4. **Draft pipeline errors** -> email: issue `message` or `culprit` contains `draft` or `all-providers-failed`, more than 3 events in 15 minutes.
5. Release health: not used (no sessions, traces off). Skip.
6. Turn the weekly digest on. Ignore known noisy errors by *fingerprint*, never by silencing the project.

`NEXT_PUBLIC_SENTRY_DSN` is already set and errors are captured today; only the rules are missing. Optional follow-up if you want source maps + a release tag: set `SENTRY_AUTH_TOKEN` (build scope) in Netlify; `COMMIT_REF`/`CONTEXT` already arrive from Netlify.

## 5. One-time cleanup observed during verification

The 2026-10-09 dry-run reported one `stuck-runs` finding ("1 radar run(s) have not moved for over 30 minutes"). It is a leftover test/abandoned run in `agent_run` (status `running`/`awaiting`), not user-facing and harmless to the product; the hourly alert would email about it until it ages out of the stuck check. Owner may leave it (no automated emails until the 24 h de-dupe claims it) or clear it in the Neon SQL editor after confirming the `id` and `user_id` are a test:

```sql
update agent_run
   set status = 'killed', updated_at = now()
 where status = 'running' and updated_at < now() - interval '30 minutes';
```

(`agent_run.radar_search` ledger is untouched by this - it only records SerpApi reservations.)

## 6. After completing this runbook

Update the readiness rows (dates + who ran them):

- `READINESS-REVERIFY.md`: R07 (uptime monitor) -> DONE, R08 (alerting) -> DONE with `?dryRun=1` result, R16 (cron heartbeats) -> DONE with check names, R01 (Neon backups) -> DONE with drill date.
- `OPERATIONS.md` §9: remove the "no uptime monitor" wording if one now exists; keep the cold-start note (it stays true forever).

These four workstreams are the last open ops items before the site is self-watching. None of them are needed for the SerpApi hackathon submission.