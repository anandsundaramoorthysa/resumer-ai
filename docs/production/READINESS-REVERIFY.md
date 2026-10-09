# Readiness register: independent re-verification

Re-scored 2026-10-08 by reading code, config and docs (grep + read, file:line cited). Nothing was deployed or called live; `.env` values were not read. Branch `feat/serpapi-job-radar`; the working tree holds about 204 uncommitted changes (109 modified, 95 untracked), so **none of the following has run through CI or been deployed**.

Checks run: `node node_modules/typescript/bin/tsc --noEmit` = 0 errors. Targeted suites, all pass: legal-export (5), consent-config (15), housekeeping-batch (5), flags (6), flags-cache (4), env-validate (3), sentry-options (3), log-scrub (6), wiring-pii (4), invite-redeem (13). `npm audit` not run (live registry call).

**Update, later the same day.** The working tree above was committed (`df757f0`, `97c5a78`, `a4c69e9`) and CI now runs green end to end — run `37760449060`: gitleaks, check (audit, typecheck, lint, 122 test suites, build, PDF-without-canvas) and coverage (all floors met). Two defects found while getting there: `ci.yml` was invalid YAML (`name: Dependency audit (blocking: critical)` — a plain scalar cannot contain `": "`), which had made every run since the workflow landed fail in 0 seconds with zero jobs and no visible reason; and gitleaks flagged four test fixtures, now allowlisted in `.gitleaks.toml`. Scores below that say "never run in CI" were true when written and are superseded by that run.

Verdicts: VERIFIED-DONE, PARTIAL, OPEN, OVERCLAIMED (marked DONE in the status table but not true), UNVERIFIABLE (lives in a dashboard or needs a live call).

## Summary counts (72 items)

| VERIFIED-DONE | PARTIAL | OPEN | OVERCLAIMED | UNVERIFIABLE |
|---|---|---|---|---|
| 12 | 29 | 25 | 4 | 2 |

VERIFIED-DONE: G04, G09, G10, G14, G15, S01, S02, S07, R12, R15, R16, R33. Even these are "in code, not yet deployed or reviewed by counsel".
OVERCLAIMED: G02, G06, G13, R18.
UNVERIFIABLE: S03 (npm audit not run), R21 (branch protection). Dashboard-only parts are also flagged inside other rows (Neon backups R01, uptime monitor R07, Sentry retention/DPA G15, heartbeat URLs R16, Groq ZDR G03).
Under-claimed by the status table (better than it says): S12, R29, R35, R37.

## Per-item table

### Legal and privacy

| ID | Verdict | Evidence | What remains |
|---|---|---|---|
| G01 | PARTIAL | `app/privacy/page.tsx`, `app/terms/page.tsx`, footer on landing, sign-in, consent, pending (`components/legal-footer.tsx`). Text inaccurate in places (see Overclaims). | Counsel review (`LEGAL-REVIEW.md`), fix inaccuracies, real entity and address. |
| G02 | OVERCLAIMED | Sign-up writes user and consent in one transaction: `app/sign-in/account-actions.ts:140-146` (and the unverified-repeat path 158-162); server-side `consent.accepted !== true` at :99. OAuth: `/consent` page + `app/consent/actions.ts:19`. BUT the gate is only `requireApprovedUser` (`lib/server/approval.ts:48`) and `/pending`. `app/page.tsx:46` checks approval only. Every `/api/*` route and most server actions call `auth()` directly (`app/api/draft/route.ts:41`, `import/*`, `export/*`, `sync`, `resume/*`) with no consent check. `LEGAL-REVIEW.md:50` admits APIs are approval-gated only. An OAuth user row (name, email, GitHub token) exists before consent is given. | Add consent check to `/`, and a shared guard for API routes and actions (or a `proxy.ts`). Decide whether OAuth rows pre-consent are acceptable. |
| G03 | PARTIAL | `AI_PII_PROVIDERS`/`AI_DISABLED_PROVIDERS` (`lib/ai/models.ts:215-225`). `containsPii` is set at only 3 call sites (`lib/import/parse.ts:183`, `lib/profile/claim.ts:166`, `lib/fit/agent.ts:430`); draft, extraction, rewrite calls are unrestricted. Unset env = all five providers incl. Gemini unpaid (`GEMINI_TIER = 'unpaid'`, `lib/legal/config.ts:60`). `AI_PII_PROVIDERS` is commented out in `.env.example:306`. | Set the allow-list in the host, drop or pay for Gemini, enable Groq ZDR, mark every PII-carrying call `containsPii`. |
| G04 | VERIFIED-DONE | `app/contact/page.tsx`, `lib/legal/config.ts:30-37` (personal Gmail). | Business mailbox (R12). |
| G05 | PARTIAL | `RUNBOOK.md:40-49` is a generic incident checklist. No breach-notification steps, templates, Board/user timelines. Privacy s.11 promises notification. | Write the breach procedure and templates. |
| G06 | OVERCLAIMED | Implemented and scheduled: `lib/server/housekeeping.ts:260-297`, `lib/radar/housekeeping.ts`, `netlify/functions/housekeeping.mts:50`. But no test runs `runHousekeeping`, the denied-account, audit-log, draft-run or ai_call SQL (`tests/housekeeping-batch.test.mts` covers only the `batched` helper). Inactive-account deletion is report-only (`:296`) while `app/privacy/page.tsx:200` promises deletion at 24 months. Accounts left `pending` are never purged. | DB-backed test for the sweep; implement notice-then-delete or reword the notice; decide on pending accounts. |
| G07 | PARTIAL | Denied: purged after 30 days (`housekeeping.ts:262-277`). Inactive: dry run only. | As G06. |
| G08 | OPEN | Residual windows stated in `app/privacy/page.tsx:203-210`; not removed. `ai_call` rows keep the deleted user's id up to 90 days (`lib/db/schema-ai.ts:17`, no FK, not in deletion path `app/settings/account/actions.ts:112-120`). | Delete `ai_call` rows by user on erasure; Sentry retention. |
| G09 | VERIFIED-DONE | `lib/legal/export-tables.ts:42-62` covers all 19 user-FK tables; test introspects the schema (`tests/legal-export.test.mts:30`), passes. Minor: `radar_search` (query text, joined via run) and `ai_call` rows are not exported. | Optional: include radar queries. |
| G10 | VERIFIED-DONE | Required checkbox `app/sign-in/sign-in-form.tsx:161-164`, server check, `/consent` page, `user_consent.ageAttested`. Self-attestation only. | Counsel on adequacy. |
| G11 | OPEN | `lib/db/schema.ts:358` "Nothing reads these yet"; disclosed in privacy s.2. | Remove or encrypt. |
| G12 | PARTIAL | `app/terms/page.tsx:29` section 2. No in-product notice found. | One line in the draft/resume UI. |
| G13 | OVERCLAIMED | Transfers disclosed (`app/privacy/page.tsx` s.5, `lib/legal/content.ts`). But Firecrawl is listed as receiving "the job-posting web address" only (`content.ts` Firecrawl row), while `lib/profile/self-evidence.ts:93-101,310` sends the user's full name, employer and title as a web search through Firecrawl (`lib/intake/scrape.ts:78`) and puts the full name in an AI prompt (`self-evidence.ts:342`). Neon region unstated. | Add the employer self-evidence flow to the notice (or remove the feature); state the Neon region. |
| G14 | VERIFIED-DONE | Cookies listed in privacy s.10 match code: theme (`app/layout.tsx:112`, `components/theme-corner.tsx:11`), sidebar (`components/desktop-sidebar.tsx:77`), Auth.js, signup-binding; sessionStorage used in `components/draft-console.tsx`, `components/radar/*`. Next fonts are self-hosted via `next/font/google` (`app/layout.tsx:2`), so no third-party font request at runtime. "Sentry sets no cookies" is default-SDK behaviour, untested in a browser. | Browser check for Sentry cookies. |
| G15 | VERIFIED-DONE (code) | `lib/sentry-options.ts` `redactText`, `sanitizeEvent`, `sendDefaultPii:false` (:131); console capture still feeds `beforeSend`. | Sentry project retention and DPA are dashboard settings (UNVERIFIABLE). |
| G16 | OPEN | No opt-in screen found; `app/settings/portfolio/portfolio-form.tsx:125` says private repos "work". | Opt-in naming AI vendors. |
| G17 | OPEN | `OPERATOR` sole proprietor, `lib/legal/config.ts:26`. | Owner decision. |
| G18 | OPEN | English only. | Later. |

### Security

| ID | Verdict | Evidence | What remains |
|---|---|---|---|
| S01 | VERIFIED-DONE | installed `next` 16.3.8 (`node_modules/next/package.json`), `package.json:next`. | Deploy it (uncommitted). |
| S02 | VERIFIED-DONE | installed nodemailer 10.0.15. | Deploy. |
| S03 | UNVERIFIABLE | `npm audit` not run (live call). | Run `npm audit --omit=dev` before launch. |
| S04 | PARTIAL | `ci.yml:30-45` gitleaks job; `ci.yml:77-82` audit blocks only CRITICAL, HIGH is `continue-on-error`; `.github/dependabot.yml`. No `.gitleaks.toml`. Blocking depends on GitHub required status checks (dashboard). Workflow has never run on this tree. | Make jobs required checks; decide whether HIGH should block. |
| S05 | PARTIAL | `permissions: contents: read`, concurrency (`ci.yml:17-25`); actions pinned by tag (`checkout@v5`, `gitleaks-action@v2.3.9`). | SHA pins. |
| S06 | OPEN | No MFA or CAPTCHA anywhere. Invite mode + approval gate is the only control. | Turnstile before public launch. |
| S07 | VERIFIED-DONE | `auth.ts:181` `maxAge`; `sessionsValidFrom` on reset (`app/settings/account/security-actions.ts:48,60`), "Sign out of all devices" UI. | None. |
| S08 | OPEN | `next.config.ts:70-71` `'unsafe-inline'`. | Nonce CSP. |
| S09 | OPEN | `lib/auth/secret-box.ts:29` `VERSION = 'v1'`, one key. | Key id and multi-key decrypt. |
| S10 | PARTIAL | Rotation table `RUNBOOK.md:18-30`; no owners or dates, no break-glass. | Inventory. |
| S11 | PARTIAL | `/admin/approvals`, `/invites`, `/flags`; flag changes write `audit_log` (`app/admin/flags/actions.ts`). No user search/suspend; approvals not attributed. | Admin audit table. |
| S12 | PARTIAL (under-claimed) | Google `email_verified` is enforced (`auth.ts:237-239`); GitHub relies on verified primary email; `linkedAccountPatch` tested (`tests/auth.test.mts:174-195`). No test for the Google `false` path. | One test. |
| S13 | PARTIAL | `lib/ai/fence.ts`, `tests/fence.test.mts`, grounding tests; no adversarial corpus. | 20-30 fixtures. |
| S14 | OPEN | `app/api/dev/e2e-draft/route.ts:46`, `selftest/route.ts:78` gated only on `NODE_ENV`. | Also require `CRON_SECRET` or exclude from prod. |
| S15 | OPEN | `public/` empty; no `.well-known`. Security email is on `/contact` only. | `security.txt` route. |
| S16 | OPEN | No edge WAF. | Cloudflare or similar. |
| S17 | OPEN | Plaintext PII columns; disclosed (privacy s.7). | Optional. |

### Reliability, ops, product

| ID | Verdict | Evidence | What remains |
|---|---|---|---|
| R01 | PARTIAL | Restore + drill procedure `RUNBOOK.md:14-15`; drill log "(none yet)" `:72`. No dump job. Plan and actual restore window are dashboard facts (UNVERIFIABLE-DASHBOARD). Privacy promises backups purge within 30 days. | Run one drill; upgrade or nightly dump. |
| R02 | PARTIAL | Still `db:push` + 8 hand-run idempotent SQL files `scripts/2026-*.sql`, order documented in `docs/production/OPERATIONS.md:57-68`, `README.md:296-303`, `RUNBOOK.md:13`. No `drizzle/` folder, no history table. CI DB suites build DDL from the Drizzle schema (`tests/db/build-ddl.mts`), not from the SQL files, so drift between the two is untested. | Versioned migrations or a test that applies the SQL and diffs. |
| R03 | OPEN | No contexts in `netlify.toml`. | Neon branch staging. |
| R04 | PARTIAL | 8 PGlite `db-*` suites inside `npm test`, run by `ci.yml:92`. `verify-*` harnesses not in CI (`ci.yml` footer comment); no Playwright config; no deploy gate. | Postgres service container, smoke E2E. |
| R05 | OPEN | `netlify.toml` header: free plan, 20 s draft clock. | Plan/background functions. |
| R06 | OPEN | Gmail SMTP (`lib/legal/content.ts`, `lib/auth/smtp.ts`). | Domain + mail vendor. |
| R07 | VERIFIED-DONE | `/api/health` (`app/api/health/route.ts`: public check is `select 1`, 2 s timeout). UptimeRobot HTTP(S) monitor on `https://resumeraiapp.netlify.app/api/health` configured 2026-10-09 (10 min interval, email). Default 2xx/3xx=up plus built-in 3x retries absorb the single Neon cold-start 503. | Re-check status from the UptimeRobot dashboard on incidents. |
| R08 | PARTIAL | Prod env confirmed set 2026-10-09 (`netlify env:list`): `CRON_SECRET`, `ALERT_EMAIL`, `SMTP_USER`, `SMTP_PASS`, `OWNER_EMAILS`; scheduled functions deployed (correct next-run times); `?dryRun=1` returned 200 with a `stuck-runs` finding, sent nothing (`ALERTING-RUNBOOK.md`). Heartbeats converged (R16). Alerts still go out through the same Gmail SMTP they would report on. Covered: credits low, stuck runs, DB down (`housekeeping.ts:350-380`). Not covered: all providers down, budget exhausted, SMTP failing, 5xx rate (Sentry rules are manual, `OPERATIONS.md:79-88`). No test exercises `collectOpsFindings`/`claimAlert`/the route. | Add Sentry rules; consider an independent external email path. |
| R09 | PARTIAL | Breaker/cooldowns exist; still free tiers. | Paid primary. |
| R10 | PARTIAL | `lib/serp/budget.ts:191` 3 runs/day, 12 credits/run, enforced in `lib/radar/runs.ts:645,818`; no monthly per-user cap. | Monthly cap. |
| R11 | OPEN | No billing. | Business decision. |
| R12 | VERIFIED-DONE | `/contact`, linked from `/pending` (`app/pending/page.tsx:43`). Personal Gmail. | Business mailbox. |
| R13 | PARTIAL | `lib/log.ts` adopted in health/cron/functions only. 88 bare `console.*` calls remain in `app/` and `lib/` (register said 72). `withRequestId` is never called outside `log.ts`, so `requestId` is always empty. | Wire request id; migrate calls. |
| R14 | PARTIAL | Targets and queries in `OPERATIONS.md`. | Dashboard. |
| R15 | VERIFIED-DONE | `RUNBOOK.md` (deploy, restore, secrets, kill switches, incident, monitoring, limits). No severity matrix, postmortem template or mail-failure entry. | Minor additions. |
| R16 | VERIFIED-DONE | `pingHeartbeat` (`lib/log.ts:117-132`); Healthchecks.io checks `draft-alerts` (1 h), `housekeeping` (1 d), `daily-sync` (1 d) created 2026-10-09; `HEARTBEAT_URL_DRAFT_ALERTS`/`_HOUSEKEEPING`/`_DAILY_SYNC` set in Netlify (scope all) and deployed; `/fail` appended on failure; `recordHeartbeat`/`deep.heartbeats` in health. First real pings: `draft-alerts` hourly at :05 UTC, others daily. Ping URLs are secrets - not committed. | None. |
| R17 | PARTIAL | `lib/env.ts` + test; report-only via `/api/health` detail, no fail-fast in prod. | Optional boot check. |
| R18 | OVERCLAIMED | Wired: `radar_enabled` (`lib/radar/handlers.ts:37-38`), `ai_enabled` (`lib/ai/daily-budget.ts:174`), `signups_enabled` (`account-actions.ts:96`, `lib/legal/invites.ts:21`). Not wired: `maintenance_message` is edited in `/admin/flags` ("Banner text shown to everyone") but nothing renders it (no `getFlag('maintenance_message')` outside the admin page). No import or sync kill switch. Fails open on DB error by design. | Render the banner or remove the flag; add import/sync switches. |
| R19 | OPEN | Additive SQL only. | Expand/contract rule. |
| R20 | OPEN | No CHANGELOG or tags (Sentry release = `COMMIT_REF`, `lib/sentry-options.ts:126`). | Tag releases. |
| R21 | UNVERIFIABLE | No CODEOWNERS or PR template. | GitHub settings. |
| R22 | PARTIAL | 105 suites. `c8` is a devDependency (`package.json:49`) but no coverage script, no floor, no CI step. No load test. | Coverage floor. |
| R23 | PARTIAL | Limits table `RUNBOOK.md:58-66`. | Load test. |
| R24 | PARTIAL | Sweep exists; no size alert. | Alert at 70%. |
| R25 | OPEN | 4 `withTimezone` uses in `lib/db/schema*.ts`. | Migration. |
| R26 | OPEN | No `security_event` table. | Later. |
| R27 | OPEN | Only verify/reset/decision mails. | Later. |
| R28 | PARTIAL | README/RUNBOOK/OPERATIONS present; no CONTRIBUTING; vendor facts partly in `lib/legal/content.ts`. | Minor. |
| R29 | OPEN (stale premise) | Fonts are self-hosted by `next/font/google`; CSP still lists fontshare hosts (`next.config.ts:72-78`). No Lighthouse in CI. | Drop dead CSP hosts; add Lighthouse. |
| R30 | PARTIAL | `app/accessibility/page.tsx:22,36` honestly says no audit and no automated testing. `scripts/ui-audit.mts` is a manual contrast/tap-target harness, not in CI. No axe. | axe in CI, manual screen-reader pass. |
| R31 | PARTIAL | `app/robots.ts` disallows all authenticated routes; sitemap and manifest exist. No `X-Robots-Tag`/noindex header. | Add header. |
| R32 | OPEN | 22 files use `force-dynamic`. | Low priority. |
| R33 | VERIFIED-DONE | `SIGNUP_MODE`, `AUTO_APPROVE_DAILY_QUOTA` (`lib/legal/config.ts:17-19,56-66`), invite redemption tests pass (13). In `invite` mode anyone can still sign up; no code = manual approval. | None. |
| R34 | OPEN | No NOTICE/licence audit. | Low. |
| R35 | PARTIAL (under-claimed) | `lib/legal/content.ts` lists what each vendor receives and where; no DPA status or exit plan; Firecrawl row inaccurate (G13). | Fix and add DPA/exit columns. |
| R36 | OPEN | No spend dashboard. | Weekly usage mail. |
| R37 | PARTIAL (under-claimed) | `app/radar/page.tsx:56` and `components/landing/landing.tsx:13` name SerpApi; privacy lists it. UI does not say what is sent. | One line. |

## Overclaims to correct in the docs

1. **READINESS.md status G02 "version bump re-prompts"**: only `requireApprovedUser` pages and `/pending` redirect. `/`, all `/api/*` routes and most server actions do not check consent. The `lib/server/approval.ts` comment "every OAuth sign-in ... goes to /consent" is true only for those pages.
2. **Status G06 "DONE"**: inactive-account deletion is report-only; the privacy notice (s.6) promises it; the sweep SQL has no DB-backed test; pending accounts are never purged. `LEGAL-REVIEW.md:18` still says the jobs are "another agent's" work.
3. **Status G13 "DONE" and privacy Firecrawl row**: Firecrawl also receives the user's full name, employer and job title (employer self-evidence search), and the name goes into an AI prompt. Not disclosed.
4. **Status R18 "DONE"**: the maintenance banner flag has no consumer; no import/sync switch.
5. **Privacy s.4 "email address and phone number are not put into AI prompts"**: true for cover letter and interview prep (`tests/wiring-pii.test.mts`), but resume import sends raw resume text including contact lines (`lib/import/parse.ts:170-183`). The next sentence hedges, but the intent claim is misleading; `LEGAL-REVIEW.md:20` says another agent is removing contact fields, which is not complete.
6. **Privacy s.2/s.6**: per-call AI telemetry (`ai_call`, with user id, 90 days) and `audit_log` 12-month retention are not mentioned; privacy says tokens expire "until they expire" while `OPERATIONS.md:50` says 7 days past expiry.
7. **Status R04/R22 "105 suites ... run in CI"**: true for count, but DB suites use a Drizzle-generated schema, not the SQL files operators actually apply.
8. **Status header "Nothing was run"** vs tsc: now verified 0 errors, but the whole tree is uncommitted so "DONE" means "in the working copy".
9. **Under-claims worth fixing**: S12 (Google verified check exists), R29 (fonts self-hosted), R35, R37.

Other policy statements checked: "Sentry has no cookies" is unverified in a browser (default SDK behaviour); "notification within the time required by law" is vague and there is no procedure behind it (G05); sub-processor list omits nothing else I could find in code; cookie list is accurate; "scrypt hash", "AES-256-GCM token", "7-day sessions", "sign out of all devices" are all true to code.

## AI-provider disclosure vs `lib/ai/models.ts`

Code chain: Groq (`openai/gpt-oss-120b`, fast `gpt-oss-20b`), Fireworks (`gpt-oss-120b`), Together (`DeepSeek-V4-Pro-0813`, fast `V4-Flash-0731`), DeepInfra (`DeepSeek-V3.2`), Google (`gemini-flash-latest`, `gemini-flash-lite-latest`). Notice lists exactly these five providers (models not named, which is fine). The notice says Google is used "only when other providers are unavailable": true only while the default order holds; `AI_PROVIDER_ORDER` can change it. The notice assumes the Gemini key is unpaid; if it is paid the config constant must change.

## Export and deletion vs schema

User-FK tables: user, account, session, github_installation, contact_info, role, profile_record, enrichment_question, enrichment_preference, application_form_fields, resume_snapshot, application, audit_log, ai_usage_daily, draft_run, sync_job, steward_dismissal, dismissed_record, agent_run (+radar_search by cascade), user_consent, invite_redemption (invite_code.created_by is set null).
- Missing from export: `radar_search` queries (reachable only via run id), `ai_call` rows (no FK), `session` (excluded with reason).
- Missing from deletion path: `ai_call` rows (kept up to 90 days, user id only). `auth_token`/`auth_attempt` by email are deleted explicitly (`actions.ts:112-120`). Denied-account purge relies on cascade only, so those emails' tokens expire on their own.

## Next actions

### Code work (solo owner or agent)
1. Gate consent everywhere: `/`, API routes, server actions (one shared guard). Test it.
2. Fix the privacy notice to match code (Firecrawl name search, resume import sends contact lines, `ai_call`/`audit_log` retention) or remove the employer self-evidence feature.
3. Implement the inactive-account notice-then-delete, or reword s.6; purge long-pending accounts; add a DB-backed test that runs `runHousekeeping` and the denied/audit/draft_run/ai_call deletes.
4. Mark every PII-carrying AI call `containsPii`; default `AI_PII_PROVIDERS` in code to a safe list rather than "all".
5. Delete `ai_call` rows by user id on account erasure.
6. Wire or remove the `maintenance_message` banner; add import and sync kill switches.
7. Commit, push, and let CI run on this tree; make gitleaks, audit and check required status checks.
8. Add a Turnstile/CAPTCHA to sign-up and reset before any open sign-up (S06).
9. Versioned migrations, or a test that applies `scripts/*.sql` to PGlite and diffs against the Drizzle schema (R02/R04).
10. Add `security.txt`, `X-Robots-Tag`, request-id wiring, a coverage floor (c8 already installed), dev-route hardening (S14).

### Dashboard and business actions
1. Netlify done 2026-10-09: `CRON_SECRET`, `ALERT_EMAIL`, `SMTP_USER`, `SMTP_PASS`, `OWNER_EMAILS` set; scheduled functions run; `/api/cron/alerts?dryRun=1` verified 200. Still to set: `SIGNUP_MODE=invite`, `AI_PII_PROVIDERS`, `AI_DISABLED_PROVIDERS=google` (or buy paid Gemini).
2. Done 2026-10-09: Healthchecks.io checks + the three `HEARTBEAT_URL_*` (Netlify, scope all); UptimeRobot monitor on `/api/health`. Still open: create the five Sentry alert rules; set Sentry retention and sign its DPA.
3. Enable Groq Zero Data Retention; read Fireworks/Together/DeepInfra terms; decide on paid AI tier.
4. Neon: confirm region and restore window; upgrade for 7-day restore or schedule a dump; do and log one restore drill.
5. Counsel review of privacy/terms (jurisdiction placeholder, DPDP wording, breach wording); decide legal entity; replace personal Gmail with a business mailbox and sending domain (R06/R12).
6. Run `npm audit --omit=dev` and resolve criticals/highs; turn on GitHub branch protection; apply the 8 SQL files in order on production before deploying.
7. Write the breach-notification procedure and templates (G05).
8. Decide billing and paid plan limits before public launch (R11).

## True verdict

(a) Invite-only beta, 50 users or fewer: **Yes with conditions.** The engine, approval gate, invite quota, export/deletion, retention jobs, health, alerts and runbook are real. It is acceptable once the code is committed and deployed, the host environment (cron secret, alert email, heartbeats, monitor) is set, and the owner tells invitees honestly that it is a beta on free-tier AI providers. Single biggest blocker: the **uncommitted, undeployed, never-CI'd working tree** plus the **unconfigured production alerting** (nothing here proves a missed cron or outage would reach the owner). Close behind: the Gemini-unpaid and "all providers allowed" PII path.

(b) Public launch: **No.** Single biggest blocker: **legal and PII exposure**: consent is not enforced on APIs or `/`, the privacy notice has verifiable inaccuracies (Firecrawl name search, resume import contact data, inactive-account deletion), resumes go to five providers including an unpaid Gemini tier with no DPAs, counsel has not reviewed anything, and the grievance contact is a personal Gmail. After that: no CAPTCHA/MFA, no billing, free-tier hosting and database, personal Gmail SMTP.
