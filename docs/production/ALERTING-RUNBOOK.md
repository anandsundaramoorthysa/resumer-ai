# Monitoring and DR runbook (external, owner's choice)


External-provider hardening that has no runtime code in this repo: heartbeat checks, an uptime monitor, a Neon point-in-time-restore drill, and the Sentry alert rules. Everything below is a **dashboard action** on external accounts - none of it can be done from this repository alone. What the repo already provides (code and endpoints) is listed first so the manual work is only the account side.

Current state (checked 2026-10-09, code merged in PR #9; later commits are docs only):

- **Heartbeats (§1, set up 2026-10-09):** Healthchecks.io checks `housekeeping` (1 d), `daily-sync` (1 d); `HEARTBEAT_URL_HOUSEKEEPING`/`_DAILY_SYNC` on Netlify. The former `draft-alerts` check is obsolete: delete it in Healthchecks.io.
- **Done (§2 uptime):** UptimeRobot HTTP(S) monitor on `https://resumeraiapp.netlify.app/api/health` (10 min, email, default 2xx/3xx=up); its built-in 3x retries absorb the single Neon cold-start 503.
- **Done (§3 Neon PITR drill):** first drill run 2026-10-09, logged at the "Restore-drill log" in `RUNBOOK.md` — branch restored from a past point-in-time on free, reference counts matched production, branch deleted.
- **Done (§4 Sentry alert rules, 2026-10-09):** issue alerts `new-issue`, `regression`, and metric Monitors `spike` (errors >10 in 1 h), `draft-pipeline-errors` (>3 in 15 m, `message:*draft*`), `providers-failed` (>3 in 15 m, `message:*all-providers-failed*`), each emailing `the owner alert address`. `SENTRY_AUTH_TOKEN` is unset (only needed for source-map uploads, not for alerting). Release health and the DPA are intentionally skipped (no session data; legal).

## Prereq: the cold-start caveat (read once)

Neon free suspends an idle database; the first `/api/health` probe after idle pays the resume and returns 503 `{"status":"degraded"}`. Every monitor below must therefore use **two consecutive failures** before alerting, or an interval short enough that a 503 (resume) or 200 (warm) is fine either way. See `OPERATIONS.md` §9. Do not set a monitor to alert on the first non-200.

## 1. Heartbeat checks (dead-man's switch for the cron jobs) — DONE 2026-10-09

Provider: **Healthchecks.io** (free) is the best fit because the repo already follows its convention (`/fail` on failure). BetterStack heartbeats work too but have no fail-endpoint convention - a missed ping is the only signal there.

1. Sign up at healthchecks.io (free plan covers 20 checks) and set the **Integrations** email to your own address.
2. Create two checks, period = the schedule, grace large enough that a Netlify deploy tick or cold function start does not page:

   | Check | Period | Grace |
   |---|---|---|
   | `housekeeping` | 1440 m (24 h) | 90 m |
   | `daily-sync` | 1440 m (24 h) | 90 m |

   Schedules are UTC; leave the check timezone at UTC or any timezone - only the cadence matters.
3. Copy the **Ping URL** of each check.
4. In Netlify: Site > Configuration > Environment variables. Add, with scope **All** (Builds, Functions, Runtime):

   ```
   HEARTBEAT_URL_HOUSEKEEPING=<ping-url>
   HEARTBEAT_URL_DAILY_SYNC=<ping-url>
   ```

   (Optional single-var alternative: set only `HEALTHCHECKS_BASE_URL` to the ping URL root; `lib/log.ts` appends `/<name>` and `/fail`.)
5. Redeploy production (env changes apply on the next build): push to `main` (CI runs, Netlify builds) or Netlify > Deploys > Trigger deploy > Clear cache and deploy site.
6. Verify without waiting for the clock:
   - Ring each route yourself with the cron secret; the function sends the ping then the route answers:
   - Confirm `hb:` rows are recorded: `GET https://resumeraiapp.netlify.app/api/health` with `x-cron-secret` shows `deep.heartbeats`.
7. Confirm a **missed** ping alerts: Healthchecks flip-alert to email is on by default; you can also check one check's "grace" behavior by toggling its status from the API during the drill.

## 2. External uptime monitor on `/api/health` — DONE 2026-10-09 (UptimeRobot, 10 min, email)

Provider: UptimeRobot free or a second Healthchecks.io HTTP check. BetterStack = paid.

- URL: `https://resumeraiapp.netlify.app/api/health`
- Expect: HTTP 200. Treat 503 as "down only if it repeats".
- Interval: 10-15 min. Anything tighter defeats Neon's scale-to-zero and spends the free compute-hour budget on probes.
- **Two consecutive failures** before alerting (cold-start 503 - prereq above). UptimeRobot "Trigger count: 2".
- Alert channel: your own email.
- The endpoint needs no auth, so the monitor needs no secret. `x-cron-secret` is only for the health *detail* view.

## 3. Neon point-in-time restore (PITR) drill

1. Confirm the window: Neon console > project > Settings > Storage/restore. Free plan = 6 h history; paid plans allow longer. If the window were 0, `db:push`-era renames and any bad migration after the last 6 h could not be rolled back - this drill proves the branch flow works.
2. Drill (repeat quarterly; ~10 min):
   - Branches > Create branch, name `pitr-drill-<yyyy-mm-dd>`, "origin" = the production branch, point in time = a few minutes ago.
   - Wait for the branch to finish provisioning (green). Copy the branch connection string (same password model as production).
   - Connect (e.g. `psql` or Neon SQL editor opened on the branch) and sanity-check:
     `select count(*) from "user";` and `select max(started_at) from draft_run;` - compare roughly to what production must have looked like at that time.
   - Delete the branch. Confirm deletion frees the storage.
3. Record the drill: date, rows seen, result. The point is that the *restore path works before you ever need it*, not that the data is meaningful.
4. Owner note: this needs Neon console access (or a Neon API token). No token is stored anywhere in this repo or repo env, so it stays a manual dashboard task.

## 4. Sentry alert rules (OPERATIONS.md §5) — DONE 2026-10-09

All rules: environment filter = `production`. Create in Sentry > Alerts > Create alert.

1. **New issue** -> email: when a new issue is created, alert. (Everything first-seen is worth a look at this scale.)
2. **Regression** -> email: issue changed resolved -> unresolved.
3. **Spike** -> email: issue seen more than 10 times in 1 hour.
4. **Draft pipeline errors** -> email: issue `message` or `culprit` contains `draft` or `all-providers-failed`, more than 3 events in 15 minutes.
5. Release health: not used (no sessions, traces off). Skip.
6. Turn the weekly digest on. Ignore known noisy errors by *fingerprint*, never by silencing the project.

`NEXT_PUBLIC_SENTRY_DSN` is already set and errors are captured today; the five alert rules are configured (see OPERATIONS.md §5). Optional follow-up if you want source maps + a release tag: set `SENTRY_AUTH_TOKEN` (build scope) in Netlify; `COMMIT_REF`/`CONTEXT` already arrive from Netlify.

## 5. After completing this runbook

Update the readiness rows (dates + who ran them):

- `READINESS-REVERIFY.md`: R07 (uptime monitor) -> DONE, R16 (cron heartbeats) -> DONE with check names, R01 (Neon backups) -> PARTIAL with drill date.
- `OPERATIONS.md` §9: remove the "no uptime monitor" wording if one now exists; keep the cold-start note (it stays true forever).

These four workstreams are the last open ops items before the site is self-watching. None of them are needed for the SerpApi hackathon submission.