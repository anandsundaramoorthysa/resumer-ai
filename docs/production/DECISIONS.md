# Owner decisions

Every choice below was made by the owner (Anand Sundaramoorthy) on 2026-10-08 and is stated
here so no later pass re-opens it. Each row says what was decided and where it is visible in
the code or the docs. "Keep" means the current behaviour is intentional, not an oversight.

## Submission (SerpApi India Hackathon 2026)

| # | Decision | Where |
|---|---|---|
| 1 | **Repository is public.** Checked `gh repo view`: `anandsundaramoorthysa/resumer-ai` is `PUBLIC`. `.env` was never tracked (only `.env.example`), and CI runs gitleaks on every push. | GitHub settings |
| 2 | **Merge `feat/serpapi-job-radar` into `main`: PENDING, on purpose.** `main` deploys to Netlify. When this happens, the SQL files in `scripts/` (filename order) must be applied to the production Neon database first, and existing accounts will land on `/consent` once. | `docs/hackathon/SUBMISSION.md` checklist |
| 3 | **Demo video: PENDING, on purpose.** Script is in `docs/hackathon/SUBMISSION.md` (under 3 minutes, sample data or a real run with keys hidden). | same |
| 4 | **License: PolyForm Noncommercial 1.0.0 + paid commercial option, kept.** Source-available, not OSI open source. Chosen for the hackathon; revisit if this becomes a product. | `LICENSE`, `COMMERCIAL-LICENSE.md`, `package.json` |

## Legal and privacy

| # | Decision | Where |
|---|---|---|
| 5 | **AI providers unchanged.** All five configured providers may receive prompts; `AI_PII_PROVIDERS` stays unset. No DPAs are in place; the owner has accepted this for a hackathon build. The privacy notice already discloses the vendors. | `lib/ai/models.ts`, `app/privacy` section 5 |
| 6 | **Gemini tier stays as it is** (unpaid). The notice states this assumption. | `GEMINI_TIER` in `lib/legal/config.ts` |
| 7 | **Groq Zero Data Retention: enabled on the Groq account** (a console setting, outside the repo). The privacy notice quotes Groq's published retention terms rather than our account state. | `app/privacy` section 5 |
| 8 | **No counsel review.** Built for a hackathon, published as source-available; a lawyer is only needed if this becomes a product. `docs/production/LEGAL-REVIEW.md` keeps the assumption list for that day. | `docs/production/LEGAL-REVIEW.md` |
| 15 | **Grievance Officer: Anand Sundaramoorthy, sanand03072005@gmail.com**, 7-day acknowledgement, 30-day resolution. Same mailbox for support and security reports. | `GRIEVANCE`, `SUPPORT_EMAIL`, `SECURITY_EMAIL` in `lib/legal/config.ts`; rendered by `/contact`, `/privacy`, `/terms` |
| 16 | **18+ age gate: enforced.** Required checkbox on the sign-in form and on `/consent`, refused server-side in `app/sign-in/account-actions.ts` and `app/consent/actions.ts`, recorded with the consent record. `MIN_AGE = 18`. | `lib/legal/config.ts`, `app/consent/consent-form.tsx` |
| 18 | **The `/consent` re-prompt after merging to `main` is accepted.** | `lib/legal/consent.ts` |

## Retention (decision 17: owner delegated the plan to the maintainer)

| Data | Kept | Decision |
|---|---|---|
| `ai_usage_daily` | **12 months** | NEW 2026-10-08. Per-user daily call/token counts, no prompt or resume text. Purged by the daily housekeeping sweep on the composite key `(user_id, day)`. Covered by `tests/db-housekeeping.test.mts`. |
| `resume_snapshot` | Until account deletion | **No automatic purge, deliberate.** These are the user's own resumes; erasure happens on account delete (cascade). Stated in the privacy notice. |
| Everything else | Unchanged | `draft_run` 90 d, `audit_log` 12 months (prompt text nulled at 90 d), `ai_call` 90 d, `agent_run` 30 d, `serp_cache` 24 h, denied accounts 30 d, inactive accounts 24 months **report-only** (notice first, delete by hand), `auth_attempt` ~2 d, `sync_job` 7 d. See `docs/production/OPERATIONS.md` section 3. |

Inactive accounts stay report-only on purpose: the privacy notice promises notice before
deletion, and no mail is sent automatically today.

## Product and operations (kept as they are)

| # | Decision | Where |
|---|---|---|
| 9 | **Email stays on the owner's personal Gmail app password.** Known limits: ~500/day, plain text, deliverability. Switch to a domain plus Resend/Postmark/SES if this launches. | `lib/auth/smtp.ts`, `.env.example` |
| 10 | **Neon free plan stays.** ~6-hour restore window, no backups. |
| 11 | **Netlify free plan stays.** The 30-second function limit is why Radar is stepped and uses SerpApi async mode. |
| 12 | **SerpApi quota stays global.** 250 free searches a month shared by all users, guarded by a cache, hourly/monthly guards, 3 runs a day per user and 12 credits a run. No per-user monthly quota. |
| 13 | **No pricing or billing.** Free invite-only product. |
| 14 | **Sign-up stays invite-only.** `SIGNUP_MODE=invite` (the default): a valid code auto-approves within a daily quota, everyone else waits for the owner. No CAPTCHA; the invite code and the approval gate are the bot defence. |
