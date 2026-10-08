# Legal review checklist for counsel

Prepared 2026-10-07. **This is not legal advice.** It lists every assumption, placeholder and unverified claim in the legal pages (`/privacy`, `/terms`, `/contact`, `/accessibility`, `/consent`) so a lawyer can confirm or correct them. All values live in `lib/legal/config.ts` and `lib/legal/content.ts`.

## 1. Placeholders to confirm or replace

| Item | Current value | Where |
|---|---|---|
| Operator / controller | Anand Sundaramoorthy, sole proprietor, India (no registered entity, no postal address) | `OPERATOR` |
| Grievance Officer | Anand Sundaramoorthy, sanand03072005@gmail.com (a personal Gmail address, also used for support and security) | `GRIEVANCE`, `SUPPORT_EMAIL`, `SECURITY_EMAIL` |
| Grievance timelines | 7-day acknowledgement, 30-day resolution (owner decision; readiness doc cites a 90-day outer limit in the DPDP Rules) | `GRIEVANCE` |
| Court jurisdiction | **"Chennai, Tamil Nadu" is a placeholder.** Confirm the owner's city and whether an exclusive-jurisdiction clause is enforceable against consumers | `JURISDICTION_CITY` |
| Versions / date | POLICY_VERSION and TERMS_VERSION 2026-10-07, effective 7 October 2026 | `config.ts` |
| Retention periods | run history 90 d, radar runs 30 d, search cache 24 h (max 30 d), denied accounts 30 d, inactive 24 months with notice, backups purged within 30 d | `RETENTION` |
| Liability cap | "amount paid, which is nothing" | `app/terms/page.tsx` s.10 |

## 2. Statements that depend on work not in this change

- **Retention jobs.** The policy promises deletion of run history, radar runs, search cache, denied accounts (30 d) and inactive accounts (24 months, with an email notice). Another agent implements the cleanup jobs; until they run, those statements are untrue. Backup purge within 30 days depends on the Neon plan (free tier restore window is about 6 hours; confirm).
- **No contact details in AI prompts.** The policy states the *intent* that email and phone are not sent to AI providers, and that SerpApi receives only role/skill/city queries. Another agent is removing contact fields from prompts; verify before launch. Free-text a user pastes is sent as-is, and the policy says so.
- **Sentry.** "No default PII, no replay, no cookies, tokens scrubbed" is from `lib/sentry-options.ts`; the claim that the browser SDK sets no cookies is from the default SDK behaviour and has not been tested in a browser. `captureConsoleIntegration` can ship fragments of user input in error text (readiness G15).
- **Email on decision** is now implemented (`lib/server/approval.ts`); mail goes through a personal Gmail account (no SPF/DKIM alignment, about 500 per day).

## 3. Provider terms (checked 2026-10-07, verify again)

- **Google Gemini API** (https://ai.google.dev/gemini-api/terms, last modified 2026-04-28): unpaid services use content to improve Google products, allow human review, and say "Do not submit sensitive, confidential, or personal information to the Unpaid Services"; paid services do not use content to improve products and log for abuse and legal purposes. **The privacy page assumes the service's key is on the UNPAID tier (`GEMINI_TIER`)** and says Google is a fallback used only when other providers fail. That order claim comes from `lib/ai/models.ts` and the readiness doc; confirm. Sending resume text, which is personal information, to an unpaid tier contradicts Google's own warning. The owner chose to keep it and disclose it; counsel should advise whether that is acceptable.
- **Groq** (https://console.groq.com/docs/your-data): no retention by default for inference, up to 30 days for troubleshooting or abuse, Zero Data Retention available, data in US GCP; page silent on training. Whether ZDR is enabled on the owner's account is **unverified**; the policy does not claim it is.
- **Fireworks, Together, DeepInfra:** the notice points to their pages and makes no claim about their retention. Not read in this pass.
- No data-processing agreement is signed with any provider. The notice says so.
- Provider "where" fields are unverified except Groq's statement and Sentry's EU endpoint (from the CSP). Neon region is not stated. Links other than the Gemini and Groq pages were not fetched.

## 4. Legal interpretation to confirm

- DPDP Act 2023 is in force; the substantive Rules (notice, consent manager, breach reporting) apply from about 13 May 2027 per the readiness audit. The notice is written to that standard early. Confirm which obligations bind a sole proprietor and whether the "Data Fiduciary" wording is right.
- Lawful basis: consent plus "legitimate uses" (s.7). Confirm which processing really fits s.7 rather than consent.
- Age: 18+ by self-attestation only (no verification). Confirm adequacy under s.9.
- Breach wording: "within the time required by law" (the Rules' 72-hour report to the Board is deliberately not stated as a number).
- Cross-border transfer (s.16): statement that no restriction currently applies to the providers used is **not** made; the text only says it will be reviewed.
- Nomination right (s.14) is handled by email only; no in-app flow.
- IT Act / SPDI Rules: the SPDI Rules' grievance-officer and privacy-policy requirements are assumed satisfied by the same notice; confirm. Intermediary Guidelines are not addressed.
- EU/UK users are not targeted; GDPR is not addressed.
- Optional "application answers" (EEO, work authorisation, salary) are collected but unused (readiness G11); the notice discloses them. They may be sensitive.
- Terms: enforceability of the exclusion and liability cap, the "AI output is not guaranteed" disclaimer, the licence grant, and consumer-law interaction (Consumer Protection Act 2019) for a free service.
- Accessibility page claims a WCAG 2.2 AA goal only; no audit exists. Confirm no jurisdiction requires a stronger statement.
- Cookies: described as strictly necessary (session, CSRF, callback, email-binding, `theme`, `sidebar`); `sessionStorage` is used for the Radar-to-drafter handoff.

## 5. Access and consent mechanics (for reference)

- Consent is recorded in `user_consent` per (user, policy version): version, terms version, age attestation, time, source (`signup` or `oauth-consent-page`). Every existing account has **no** record and is sent to `/consent` on its next visit.
- Gate: `requireApprovedUser`, the dashboard (`requireConsentAndApproval`) and `/pending` redirect to `/consent` when there is no record for the current `POLICY_VERSION`. The AI choke point (`assertDailyBudget`) and the radar gate also refuse API calls without current consent ("Please accept the Terms and Privacy Policy to continue."); owner accounts are exempt from quotas but not from consent. `/consent`, account deletion and export are deliberately not gated. Other server actions that touch no AI or radar path (for example profile edits) are still gated by approval only. Counsel should confirm that is acceptable.
- Signup mode env: `SIGNUP_MODE` = `invite` (default; a valid code auto-approves under the quota, no code means manual approval), `open` (every new account auto-approved under the quota on first visit to `/pending`), `manual` (codes ignored). `AUTO_APPROVE_DAILY_QUOTA` (default 20 per India-time day).
- Invite codes: 12-character Crockford base32, stored as SHA-256, shown once. Redemption is rate limited under the existing `verify` limiter.
- `scripts/2026-10-07-consent-invites.sql` creates the tables; apply it by hand before deploying (not applied to any database by this change).

## 6. Corrections of 2026-10-08 (POLICY_VERSION 2026-10-08; everyone re-consents)

Text changed to match the code (code was not weakened):
- Resume import sends the RAW resume text, including name, email, phone and links, to the AI providers. The earlier sentence that email and phone are never put into AI prompts was removed. True statements kept: cover-letter prompts strip email, phone and profile links (`lib/ai/redact.ts`); Radar queries to SerpApi contain only titles, skills and cities.
- Evidence search (`lib/profile/self-evidence.ts`, only when the user clicks it on a profile bullet): full name, employer and title go to Firecrawl as a web search and the name goes into an AI prompt. Disclosed in the sub-processor table.
- Retention table: added `ai_call` (90 days), `audit_log` (12 months, prompt text nulled after 90 days).
- Denied accounts (30 days) ARE purged by the daily housekeeping job. Inactive accounts (24 months) are only REPORTED (`selectInactiveAccounts`); the notice now says review and deletion is manual after notice.
- `AI_PII_PROVIDERS` unset means all five providers, including Google's unpaid Gemini tier (Google may use and human-review content), may receive resumes. Owner can restrict; stated.
- AI daily budget is the UTC day (resets 05:30 IST); radar runs and invite quota use the IST day (`lib/time/ist.ts`).

Code changes touching legal behaviour:
- Consent is now enforced outside pages too: `app/page.tsx`, `assertDailyBudget` (all AI routes; owner NOT exempt from consent, only from quotas) and the radar gate return "Please accept the Terms and Privacy Policy to continue." Consent page, account deletion and export stay reachable without consent.
- Invite quota tombstones: `invite_redemption.user_id` is nullable, ON DELETE SET NULL (`scripts/2026-10-08-invite-tombstone.sql`, idempotent; confirmed applied to production 2026-10-08). Tombstone rows hold no personal data and are exported to no one.
- Erasure now deletes `ai_call` rows; export includes a trimmed `aiCalls`; `radar_search` is excluded from export with a reason (deleted by cascade).
- Password signups redeem an invite only after the email is verified (code held in an httpOnly cookie; other browser: enter the code on /pending).
- Sentry events are scrubbed over the whole event; rate limiting uses one trusted IP header (`TRUST_PROXY`).

Open counsel questions: whether sending raw resume text to the unpaid Gemini tier is acceptable without a data-processing agreement; whether the evidence search (name to a web search engine) needs a separate explicit consent; whether a manual 24-month inactivity process satisfies the DPDP storage-limitation duty; whether keeping the invite tombstone row (no user id, timestamp only) needs disclosure.
