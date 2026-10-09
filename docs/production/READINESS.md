# Resumer AI - production readiness audit

## Status as of 2026-10-08

> Superseded by `READINESS-REVERIFY.md` (re-checked 2026-10-09): R07 uptime monitor, R08 alerting and R16 cron heartbeats are now VERIFIED-DONE, and the first Neon PITR restore drill is logged at `RUNBOOK.md:72`. Rows below are the original 2026-10-06 audit and are left unedited.

Re-checked against the code (grep or read; nothing was run). The register below is the original 2026-10-06 audit and is left unedited. DONE = implemented in code; PARTIAL = implemented in part or needs an owner action; OPEN = not addressed; UNVERIFIABLE = lives outside the repo. "Done" means present in code, not that it has been reviewed by counsel or deployed.

**Verdict is unchanged in kind:** a strong single-owner engine. The P0 items that were code are now done; what remains is mostly owner decisions (entity, providers, paid plans, counsel).

| Item | Status | Evidence |
|---|---|---|
| G01 privacy notice, terms | DONE (text is placeholder-grade) | `app/privacy`, `app/terms`; counsel items in `LEGAL-REVIEW.md` |
| G02 consent record | DONE | `user_consent`, `/consent`, version bump re-prompts (`lib/legal/consent.ts`) |
| G03 PII to vendors | PARTIAL | `AI_PII_PROVIDERS` and `AI_DISABLED_PROVIDERS` (`lib/ai/models.ts`), `lib/ai/redact.ts`; the provider choice, Groq ZDR and the Gemini unpaid tier remain owner decisions |
| G04 grievance contact | DONE (address is personal Gmail) | `app/contact`, `GRIEVANCE` in `lib/legal/config.ts` |
| G05 breach procedure | PARTIAL | incident checklist in `RUNBOOK.md`; no breach-notification procedure or comms templates |
| G06 retention | DONE | `lib/server/housekeeping.ts` (incl. `ai_usage_daily` 12 months, added 2026-10-08), `lib/radar/housekeeping.ts`, daily function `housekeeping.mts`; `resume_snapshot` deliberately not purged - see `DECISIONS.md` |
| G07 denied/inactive accounts | PARTIAL | denied purged after 30 days; inactive accounts are report-only, deleted by hand |
| G08 erasure is DB-only | OPEN | residual windows are stated in the privacy notice, not removed |
| G09 export completeness | DONE | `lib/legal/export-tables.ts` includes radar runs, dismissals, enrichment, installations, consent; `tests/legal-export.test.mts` |
| G10 age gate | DONE | 18+ attestation at sign-up and `/consent` |
| G11 unused EEO/salary fields | OPEN | `lib/db/schema.ts` still marks them "nothing reads these yet" |
| G12 AI-use disclosure | PARTIAL | `app/terms` section 2 "AI-assisted output"; no in-product notice checked |
| G13 cross-border transfers | DONE | `app/privacy` section 5 |
| G14 cookies | DONE | `app/privacy` section 10 |
| G15 Sentry PII | DONE (code) | emails/phones redacted, messages truncated (`lib/sentry-options.ts`); retention and DPA are settings outside the repo |
| G16 private-repo opt-in | OPEN | not found |
| G17 legal entity | OPEN | owner decision (`OPERATOR` is a sole proprietor) |
| G18 notice language | OPEN | English only |
| S01 Next RCE | DONE | `package.json` `next` 16.3.8 |
| S02 nodemailer | DONE | `^10.0.15` |
| S03 transitive advisories | UNVERIFIED | `npm audit` was not run for this status |
| S04 audit gate, Dependabot, secret scan | DONE | `ci.yml` (audit, gitleaks), `.github/dependabot.yml` |
| S05 CI hardening | PARTIAL | `permissions: contents: read` and concurrency added; actions still pinned by tag, not SHA |
| S06 MFA / CAPTCHA | OPEN | none in code; invite codes and the approval gate limit sign-up instead |
| S07 sessions | DONE | 7-day `maxAge`; password reset invalidates sessions (`sessionsValidFrom`) |
| S08 CSP nonce | OPEN | `script-src` still has `'unsafe-inline'` (`next.config.ts`) |
| S09 key rotation | OPEN | `secret-box.ts` is still `v1` with one key |
| S10 secret inventory | PARTIAL | rotation table in `RUNBOOK.md`; no inventory with owners and dates |
| S11 admin console | PARTIAL | `/admin/approvals`, `/admin/invites`, `/admin/flags` (flag changes audited); no user search or suspend |
| S12 verified-email linking test | OPEN | not found |
| S13 injection corpus | PARTIAL | `lib/ai/fence.ts` nonce fences with tests (`tests/fence.test.mts`); no dedicated adversarial corpus |
| S14 dev routes in prod build | PARTIAL | still gated only by `NODE_ENV` |
| S15 security.txt | OPEN | `public/` is empty |
| S16 edge WAF | OPEN | |
| S17 PII columns plaintext | OPEN | |
| R01 backups | PARTIAL | restore procedure and drill in `RUNBOOK.md`; no automated dump, plan upgrade not done |
| R02 migrations | PARTIAL | additive idempotent SQL files applied in order; still no migration history table |
| R03 staging | OPEN | |
| R04 DB-backed CI | PARTIAL | `db-*` suites run on in-memory PGlite inside `npm test` and CI; real-database `verify-*` harnesses are not in CI; no E2E |
| R05 platform limits | OPEN | still Netlify free |
| R06 email | OPEN | still a Gmail app password |
| R07 uptime monitor | PARTIAL | `/api/health` and setup steps documented; whether a monitor is configured is UNVERIFIABLE |
| R08 alerting | PARTIAL | `/api/cron/alerts` (credits low, stuck radar runs, DB down), failed-draft email, Sentry rule list in `OPERATIONS.md` |
| R09 AI capacity | PARTIAL | breaker, cooldowns, model-gone bench; providers are still free tiers |
| R10 SerpApi quota | PARTIAL | 3 runs a day and 12 credits a run per user, credit reservations, low-credit alert; no per-user monthly quota |
| R11 billing | OPEN | |
| R12 support channel | DONE | `/contact` (address is personal Gmail) |
| R13 structured logs | PARTIAL | `lib/log.ts` adopted in health, cron and Netlify functions; many bare `console.*` calls remain |
| R14 SLOs | PARTIAL | suggested targets and queries in `OPERATIONS.md`; no dashboard |
| R15 runbooks | DONE | `RUNBOOK.md` |
| R16 cron heartbeats | DONE | `pingHeartbeat` in `lib/log.ts`, `hb:` rows, `deep.heartbeats` in health |
| R17 env validation | DONE | `lib/env.ts`, reported by `/api/health` |
| R18 kill switches | DONE | `lib/server/flags.ts` is wired into the radar handlers, the AI daily budget, sign-up and invites, plus `/admin/flags` |
| R19 schema rollback | OPEN | additive-only SQL is the mitigation |
| R20 releases | OPEN | no CHANGELOG or tags |
| R21 branch protection | UNVERIFIABLE | no CODEOWNERS in the repo |
| R22 testing | PARTIAL | 105 offline suites; no coverage metric, no load test |
| R23 capacity plan | PARTIAL | limits table in `RUNBOOK.md` |
| R24 storage growth | PARTIAL | retention sweep exists; no size alert |
| R25 timestamps | OPEN | |
| R26 security audit trail | OPEN | no `security_event` table |
| R27 account-change mails | OPEN | |
| R28 docs | PARTIAL | README, RUNBOOK, OPERATIONS, ARCHITECTURE refreshed; no CONTRIBUTING or vendor register |
| R29 performance | OPEN | |
| R30 accessibility | PARTIAL | `/accessibility` statement page; no automated audit |
| R31 robots | DONE | `app/robots.ts` disallows the signed-in routes; no `X-Robots-Tag` header checked |
| R32 static pages | OPEN | |
| R33 sign-up policy | DONE | `SIGNUP_MODE`, invite codes, `AUTO_APPROVE_DAILY_QUOTA` |
| R34 licence audit / NOTICE | OPEN | no NOTICE file |
| R35 vendor register | OPEN | |
| R36 spend dashboard | OPEN | |
| R37 radar disclosure | PARTIAL | the privacy notice describes SerpApi queries; an in-UI line was not checked |

All 72 rows (G01-G18, S01-S17, R01-R37) are covered above.

---

Audited 2026-10-06, branch `feat/serpapi-job-radar` @ `ba13484`. Read-only audit; this file is the only thing written.
Method: read config/auth/db/ai/api/cron/CI, grep-verified every "absent" claim, ran `tsc --noEmit` (clean, 0 errors) and `npm audit --omit=dev` (on a copy of package files in a scratch dir; **8 vulns: 1 critical, 4 high, 3 moderate**). No secrets were read or printed; no paid API was called.
Prior work: `PRODUCTION-AUDIT.md` (2026-09-11) fixed the engineering-level findings. This audit is about what is *around* the code.

---

## A. Verdict (one page)

**Not production-grade for real public users yet. It is a very good one-person engine with no operating company around it.**

Strong (keep): grounded-claim resume pipeline; per-draft, per-day and app-wide AI budgets (`lib/ai/daily-budget.ts`); DB-backed auth rate limits (`lib/auth/rate-limit.ts`); owner approval gate enforced at the AI choke point (`lib/server/approval.ts`); AES-256-GCM token encryption (`lib/auth/secret-box.ts`); SSRF-safe fetch, zip-bomb caps, security headers (`next.config.ts`); Sentry with scrubbing and no replay (`lib/sentry-options.ts`); account delete + JSON export (`app/settings/account/actions.ts`, `app/api/account/export/route.ts`); constant-time cron secret; 71 offline test suites; CI with typecheck/lint/test/build; error boundaries (`app/error.tsx`, `app/global-error.tsx`).

What makes it "one-person" rather than production:
1. **No legal surface.** No privacy notice, terms, consent capture, grievance contact, breach plan or retention policy. Resumes are PII. DPDP Rules obligations become enforceable about 13 May 2027 (18 months after the 13 Nov 2025 notification).
2. **PII goes to five LLM vendors on free tiers with no DPA** (the app itself says so: `app/settings/application/page.tsx:147`). Google's unpaid tier uses content to improve products and allows human review.
3. **A critical dependency vuln is live**: Next 16.3.4 RCE in `next/og` `ImageResponse`, and the app uses it (`app/opengraph-image.tsx:1`). The fix is a patch bump.
4. **Operations are a hobby setup**: Netlify free (30 s kill, draft clock cut to 20 s), Neon free (6 h restore window), personal Gmail SMTP (500/day, no domain auth), no uptime monitor, status page or support channel, one alert (hourly draft failures), no runbooks, `db:push` instead of migrations, no staging.
5. **No business model in code**: no billing or plans; the owner pays every provider; SerpApi free credits (250/month) are shared by everyone.
6. **Bus factor 1**: single admin via env var, no secret inventory or rotation, no branch-protection evidence, no CODEOWNERS/Dependabot/changelog.

Recommended order: Stage 0 blockers (1-2 weeks), Stage 1 launch-ready, Stage 2 scale (section D). Gap counts are at the end of section B.

---

## Part 1 - Research digest (what applies here, with sources)

| Domain | Compressed requirement for this app | Source |
|---|---|---|
| Launch readiness (SRE) | Launch checklist: capacity, failure modes, monitoring/alerting, rollout plan, data/security, docs/on-call. Define SLOs and error budgets; blameless postmortems. | https://sre.google/sre-book/launch-checklist/ , https://sre.google/sre-book/service-level-objectives/ |
| 12-factor | Config in env (validate at boot), logs as event stream to stdout, dev/prod parity, admin tasks (migrations) as one-off processes. | https://12factor.net/ |
| AWS Well-Architected | Reliability (backups, tested recovery, change mgmt), Security (least privilege, data protection, incident response), Operational Excellence (runbooks, observability, small reversible changes), Cost. | https://aws.amazon.com/architecture/well-architected/ |
| OWASP ASVS / Top 10 / API Top 10 | L1 baseline: authN, session mgmt, access control, validation, logging, config; L2 adds MFA. API Top 10: object-level auth, resource consumption, SSRF. | https://owasp.org/www-project-application-security-verification-standard/ , https://owasp.org/Top10/ , https://owasp.org/API-Security/ |
| OWASP LLM Top 10 (2025) | Prompt injection (LLM01), sensitive info disclosure (LLM02), supply chain (LLM03), excessive agency (LLM06), unbounded consumption (LLM10). Treat job posts and scraped repos as untrusted. | https://genai.owasp.org/llm-top-10/ |
| Next.js / Netlify | Netlify sync and scheduled functions default 30 s, background functions 15 min, 6 MB buffered payload. Atomic deploys, instant rollback, deploy previews. CSP with nonces preferred over `unsafe-inline`. | https://docs.netlify.com/functions/overview/ , https://nextjs.org/docs/app/guides/content-security-policy |
| Neon / Postgres | Use the pooled (`-pooler`) string on serverless; restore window Free about 6 h/1 GB, Launch 7 d, Scale 14 d (verify on the pricing page before buying); branches for staging; versioned migrations. | https://neon.com/docs/connect/connection-pooling , https://neon.com/pricing , https://orm.drizzle.team/docs/migrations |
| Email deliverability | SPF + DKIM + DMARC with an aligned From domain; a personal Gmail app password is neither aligned nor scalable. | https://support.google.com/a/answer/81126 , https://dmarc.org/overview/ |
| SaaS must-haves | Status page, support contact, ToS/Privacy, quotas/billing, abuse controls, transactional email provider. | industry practice (no single normative source) |
| India DPDP Act 2023 | Notice + consent (s.5-6), purpose limitation, security safeguards (s.8(5)), breach intimation to Board and affected persons (s.8(6)), erase when purpose served (s.8(7)), grievance redressal (s.8(10), s.13), principal rights: access, correction, erasure, nomination (s.11-14), child = under 18 with verifiable parental consent (s.9), penalties up to INR 250 crore (Schedule). Notice in English or any Eighth-Schedule language (s.5(3)). | https://www.meity.gov.in/writereaddata/files/Digital%20Personal%20Data%20Protection%20Act%202023.pdf |
| DPDP Rules 2025 | Notified 13 Nov 2025. Rules 1-2, 17-21 immediate; Rule 4 after 1 year; **Rules 3, 5-16, 22-23 after 18 months (~13 May 2027)**. Rule 3: standalone notice, itemised data and purpose. Breach: intimate without delay plus detailed report to the Board within 72 h. Rule 10: verifiable parental consent for under-18. Grievance redressal within 90 days. Third Schedule erasure timelines / 1-year log retention apply to specified classes of fiduciary (e-commerce, gaming, social media); confirm with counsel whether a resume tool is in scope. | https://www.legal500.com/developments/?p=53484 , https://www.khaitanco.com/sites/default/files/2025-11/ERGO%20-%20Digital%20Personal%20%20Data%20Protection%20Rules%20-%2015%20November%202025.pdf , https://www.scconline.com/blog/post/2025/11/14/meity-notified-digital-personal-data-protection-rules-2025/ |
| GDPR basics (any EU user) | Lawful basis, art.13 notice, DSAR within one month, erasure, art.28 processor agreements, transfer mechanism (SCCs), 72 h breach notice to authority (art.33). | https://gdpr-info.eu/ |
| AI provider data terms (checked via search 2026-10-06; re-verify on live pages) | **Google Gemini API unpaid tier: content may be used to improve products and human reviewers may read it; paid tier: not used.** Groq: no training; inputs/outputs may be logged up to 30 days unless Zero Data Retention is enabled in Data Controls; data held in US GCP. Fireworks: zero retention by default for open models; no training without opt-in. Together: no training without opt-in; retention can be disabled in settings. DeepInfra: inputs/outputs not stored to disk, not trained on (third-party model terms apply for Google/Anthropic models). None of these is a signed DPA by default. | https://ai.google.dev/gemini-api/terms , https://console.groq.com/docs/your-data , https://docs.fireworks.ai/guides/security_compliance/data_handling , https://www.together.ai/privacy , https://deepinfra.com/docs/data |
| Supply chain | `npm ci` + lockfile (done), audit gate, Dependabot/Renovate, SBOM (CycloneDX), actions pinned by SHA, least-privilege `permissions:`, provenance. | https://slsa.dev/ , https://docs.github.com/en/code-security/dependabot , https://cyclonedx.org/ |
| SDLC | CI gates, branch protection + required review, semver + changelog, feature flags, canary/preview, expand-contract DB changes. | https://semver.org/ , https://keepachangelog.com/ |
| Accessibility | WCAG 2.2 AA as target; axe/pa11y in CI plus manual keyboard and screen-reader pass; accessibility statement. | https://www.w3.org/TR/WCAG22/ |
| Performance | Core Web Vitals p75: LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1. | https://web.dev/articles/vitals |
| Observability / DR | Structured logs with request id, RED metrics, SLO-based alerts, runbooks, defined RPO/RTO, restore drills. | SRE book + Well-Architected links above |

---

## B. Gap register

Severity: P0 blocker (no real users until fixed) / P1 must-have before real users / P2 should / P3 nice. Effort: S (<1 d) / M (1-5 d) / L (>1 wk). Decision = needs an owner/business choice.

### Legal and privacy

| ID | Area | Gap | Why it matters | Evidence | Sev | Eff | Recommended fix | Decision |
|---|---|---|---|---|---|---|---|---|
| G01 | Legal | No privacy notice or terms of service | Resumes are PII; DPDP s.5 / Rule 3 notice; users cannot know purposes, vendors, retention | absent: no `app/privacy`, `app/terms`; grep "privacy policy / terms of / i agree" in app+components = 0 hits | P0 | M | Write standalone Privacy Notice + ToS (counsel review); link from footer, sign-up, landing | yes (legal entity) |
| G02 | Legal | No consent capture at sign-up; no consent record, timestamp or version | DPDP s.6 consent must be informed and provable | `app/sign-in/sign-in-form.tsx` has no checkbox; `users` has no consent columns (`lib/db/schema.ts:24-66`) | P0 | S | Required checkbox; store `consentVersion`, `consentAt`; re-prompt on version bump | no |
| G03 | AI / privacy | PII (profile, bullets, job history, GitHub repo text) is sent to up to 5 LLM vendors with no DPA; Gemini free tier trains/reviews | Vendor-side retention/training of user PII; purpose limitation; transfer issue | `app/settings/application/page.tsx:147` admits no DPA; `lib/ai/models.ts` chain groq > fireworks > together > deepinfra > google | P0 | M | Decide allowed providers; drop the Gemini free key from the user path (or go paid); enable Groq ZDR; accept others only after written no-train/no-retention; list vendors in the notice; enforce via `AI_PROVIDER_ORDER` | yes |
| G04 | Legal | No grievance officer, contact or DSAR intake | DPDP s.8(10)/s.13, redress within 90 days; GDPR one-month DSAR | absent: no contact/help page; grep "grievance" = 0 | P1 | S | Publish grievance contact, monitored mailbox, SLA | yes (who/what email) |
| G05 | Legal | No breach detection/response/notification procedure | DPDP s.8(6); Rules 72 h report; GDPR art.33 | absent: no incident doc; only hourly draft alerts | P1 | M | Incident runbook, comms templates, decision owner, vendor breach contacts | no |
| G06 | Privacy | No retention policy; most tables grow forever | Erasure when purpose served (DPDP s.8(7)); Neon storage | `lib/server/housekeeping.ts` purges only auth_attempt, tokens, sync_job; `draft_run`, `audit_log`, `resume_snapshot`, `agent_run`, `serp_cache`, `ai_usage_daily` never purged | P1 | M | Retention per table; extend housekeeping | yes |
| G07 | Privacy | Denied and inactive accounts keep PII forever | Same as G06 | `users.approval` has `denied`, no purge (`lib/server/approval.ts`) | P1 | S | Delete denied after N days; warn then delete inactive | yes |
| G08 | Privacy | Erasure is DB-only | Copies persist in Neon restore window, Sentry events, provider logs (Groq up to 30 d) | `app/settings/account/actions.ts:42` single cascade delete | P2 | M | State residual windows in notice; Sentry retention; ZDR | no |
| G09 | Privacy | Data export incomplete | Right of access should cover all personal data | export omits `agent_run`, `dismissedRecords`, `stewardDismissals`, `enrichmentPreferences`, `githubInstallations`, profile fields (`app/api/account/export/route.ts:35-46`) | P2 | S | Add tables; test that fails when a user-keyed table is not exported | no |
| G10 | Privacy | No age gate or parental-consent path | DPDP s.9 / Rule 10: under 18 = child | absent: no age check | P1 | S | 18+ attestation at sign-up | yes |
| G11 | Privacy | EEO answers, salary, work authorisation stored with no active purpose | Data minimisation / purpose limitation | `lib/db/schema.ts:356-366` ("reserved for Phase 10 ... nothing reads these"); form at `app/settings/application/*` | P2 | S | Remove collection until used, or encrypt and state purpose | yes |
| G12 | AI | No AI-use disclosure or accuracy disclaimer | Transparency; users sign AI-written resumes | absent in app/components outside dev copy | P2 | S | In-product notice + ToS clause; human review exists (`app/resume/[snapshotId]/resume-editor.tsx`) | no |
| G13 | Privacy | Cross-border transfers undisclosed | DPDP s.16 allows transfer except to restricted countries; GDPR needs SCCs | Sentry EU ingest in CSP; other vendors unstated | P2 | S | List vendors and countries; confirm Neon/Netlify regions | no |
| G14 | Privacy | No cookie disclosure | Only essential auth cookies and no analytics SDK (`package.json`), so a banner is likely unnecessary, but disclosure is missing | n/a | P3 | S | Mention in notice; add banner only if analytics added | no |
| G15 | Privacy | Sentry may capture PII in error text | `captureConsoleIntegration` ships any `console.error` string | `instrumentation.ts:8`; `lib/sentry-options.ts:33-45` scrubs tokens/keys only | P2 | S | Scrub email/phone patterns; 30 d retention; sign Sentry DPA | no |
| G16 | Privacy | Private-repo contents sent to LLMs without explicit opt-in screen | Confidential third-party data | `lib/sync/*`, `syncJobs.corpus` | P2 | S | Opt-in screen naming vendors before first sync | no |
| G17 | Legal | No legal entity or business identity in product; copyright is personal | ToS counterparty, invoicing, liability | `LICENSE` "Copyright (c) 2026 Anand Sundaramoorthy" | P2 | M | Decide proprietorship vs company; state in ToS | yes |
| G18 | Legal | Notice English-only | DPDP s.5(3) option of Eighth-Schedule language | n/a | P3 | M | Add Hindi/Tamil once notice is final | yes |

### Security

| ID | Area | Gap | Why it matters | Evidence | Sev | Eff | Recommended fix | Decision |
|---|---|---|---|---|---|---|---|---|
| S01 | Supply chain | **Critical**: Next 16.3.4 is in the vulnerable range 16.2.0-16.3.5; RCE in `next/og` ImageResponse (GHSA-vcvr-r3jv-pc5j) | Remote code execution; app uses ImageResponse | `npm audit`; `node_modules/next/package.json` 16.3.4; `app/opengraph-image.tsx:1,15` | P0 | S | Bump `next` and `eslint-config-next` to >= 16.3.8, rebuild, deploy | no |
| S02 | Supply chain | nodemailer 10.0.0 (<=10.0.8) has 4 advisories incl. SMTP credential disclosure (GHSA-6vj9-mwq6-2f5v) | SMTP creds, mail DoS | audit; `package.json` nodemailer ^10.0.0 | P1 | S | Upgrade to fixed release | no |
| S03 | Supply chain | High transitive: sharp, brace-expansion, source-map-js; moderate: mammoth (suggested fix is a downgrade to 0.3.29), argparse, sprintf-js | Known CVEs | audit JSON | P2 | S | `npm audit fix` where safe; evaluate mammoth; add audit gate | no |
| S04 | Supply chain | No audit gate, Dependabot/Renovate or secret scan in CI | S01 was found only by this audit | `.github/` has only `workflows/ci.yml` | P1 | S | `dependabot.yml` (npm + actions); `npm audit --omit=dev --audit-level=high` job; gitleaks | no |
| S05 | CI security | Actions pinned by tag, no `permissions:` block, no concurrency | Tag hijack; default token scope | `.github/workflows/ci.yml` (`actions/checkout@v5`, `setup-node@v5`) | P2 | S | Pin SHAs; `permissions: contents: read` | no |
| S06 | AuthN | No MFA/passkeys; no CAPTCHA on open sign-up | Takeover (ASVS L2); bot sign-ups spam owner mailbox and burn Gmail quota | grep captcha/turnstile/totp/mfa = 0; only rate limits (`lib/auth/rate-limit.ts:70-80`) | P1 | M | Turnstile/hCaptcha on sign-up/reset; TOTP later | yes (public vs invite-only) |
| S07 | Sessions | JWT sessions with default lifetime, revocation only via password reset | Stolen cookie valid for weeks; no device list | `auth.ts:175`; no `maxAge` | P2 | S | Set `maxAge` 7 d; "sign out everywhere" using `sessionsValidFrom` | no |
| S08 | CSP | `script-src 'unsafe-inline'` | Weakens XSS defence | `next.config.ts` csp array (comment admits nonce needed) | P2 | M | Nonce CSP via `proxy.ts` (none exists); report-only first | no |
| S09 | Secrets | Single encryption key, no key id or rotation | Cannot rotate after leak; key loss breaks fit tokens too | `lib/auth/secret-box.ts` (VERSION v1, one `TOKEN_ENC_KEY`) | P2 | M | Key-id prefix, multi-key decrypt, rotation runbook | no |
| S10 | Secrets | No secret inventory, rotation schedule or break-glass doc | Bus factor | absent | P2 | S | Inventory table in runbook | no |
| S11 | Admin | Admin = emails in `OWNER_EMAILS`; one page; no user search/suspend/delete/usage; decisions not audit-logged (who) | Cannot handle abuse or support | `app/admin/approvals/*`; only `users.approvalDecidedAt` | P2 | M | Admin console + `admin_audit` table | no |
| S12 | AuthZ | Email-based account linking for GitHub and Google | Takeover if a provider returns an unverified email | `auth.ts:198,207` `allowDangerousEmailAccountLinking` (justified in comments) | P3 | S | Keep; add test requiring verified email | no |
| S13 | LLM | No adversarial prompt-injection corpus for postings and repos | OWASP LLM01 | mitigations exist (`lib/generate/grounding.ts`, `tests/grounding.test.mts`, `tests/radar-route.test.mts`) but no dedicated corpus | P2 | M | 20-30 injection fixtures; filter URLs/emails not in profile | no |
| S14 | Surface | Dev routes ship in the prod build, gated only by NODE_ENV | One misconfig exposes them | `app/api/dev/e2e-draft/route.ts:46`; `app/api/dev/selftest/route.ts` | P2 | S | Exclude from prod or also require `CRON_SECRET` | no |
| S15 | Surface | No `security.txt` or disclosure policy; `public/` is empty | No researcher channel | `public/` empty | P3 | S | `/.well-known/security.txt` | no |
| S16 | Edge | No WAF/edge IP limits; rate limit costs a DB write per request | DB DoS, Neon compute | `lib/auth/rate-limit.ts` | P3 | M | Edge/Cloudflare in front | yes (paid) |
| S17 | Data | PII columns plaintext in Postgres (contact, EEO, salary); only OAuth tokens encrypted | DB or backup leak | `lib/db/schema.ts:188-199,358-366` | P3 | M | Field-level encryption if kept | no |

### Reliability, infrastructure, product

| ID | Area | Gap | Why it matters | Evidence | Sev | Eff | Recommended fix | Decision |
|---|---|---|---|---|---|---|---|---|
| R01 | DR | Backups: Neon free = ~6 h restore window; no logical dump, restore drill, RPO/RTO | One bad `db:push` or delete = permanent loss | `.env.example:14-17`; no backup script/workflow | P1 | M | Paid Neon (7 d) or nightly `pg_dump` to object storage; RPO 24 h / RTO 4 h; quarterly drill | yes (paid) |
| R02 | Migrations | Schema via `db:push` and hand-run SQL; no migration history | Cannot prove prod == code; no rollback; push can drop data | `package.json` `db:push`; `drizzle.config.ts` `out:'./drizzle'` but no folder; `scripts/2026-10-06-job-radar.sql`; `PRODUCTION-AUDIT.md:427` | P1 | M | `drizzle-kit generate` + `migrate` in release step; baseline; expand/contract | no |
| R03 | Environments | No staging or preview DB | Risky changes tested on real data | `netlify.toml` has no contexts | P1 | M | Neon branch per preview/staging; per-context env | yes (cost) |
| R04 | CI/CD | DB-backed verify-* suites not in CI; no E2E; no deploy gate | Auth/authz/sync regressions reach prod | `.github/workflows/ci.yml:58-62` ("Deliberately not run"); `@playwright/test` dev-dep but no config or spec dir | P1 | M | Postgres service container; run verify-auth/authz/crud; Playwright smoke; block merge | no |
| R05 | Platform | Netlify free: 30 s limit forces 20 s draft clock and fewer iterations; `maxDuration=300` is ineffective on this plan; plan ToS for commercial use unverified | Quality and reliability capped by plan | `netlify.toml:1-14`; `app/api/draft/route.ts:29` | P1 | M | Background functions (15 min) or paid plan; re-measure; check plan terms | yes (paid) |
| R06 | Email | Mail via personal Gmail app password: ~500/day, not domain-aligned, plain text, no bounce handling | Verification/reset land in spam or throttle; sign-up funnel breaks | `.env.example:89-101`; `lib/auth/smtp.ts`, `lib/auth/mail.ts` | P1 | M | Own domain + Resend/Postmark/SES; SPF, DKIM, DMARC; bounce webhook | yes (domain, vendor) |
| R07 | Monitoring | No uptime monitor or status page | Outages found by users | `/api/health` exists but nothing polls it | P1 | S | External monitor on `/api/health` + status page | no |
| R08 | Alerting | Only alert is hourly draft-failure email; none for 5xx rate, DB down, missed cron, all-providers-down, budget exhausted, SMTP failing | Silent failure (ten failed deploys went unnoticed per `netlify.toml` comment) | `netlify/functions/draft-alerts.mts`; Sentry DSN optional, no alert rules in repo | P1 | M | Sentry alert rules; Netlify deploy-failed notify; dead-man's switch | no |
| R09 | AI capacity | All providers free/low tier; Gemini quota already exhausted; order tuned for latency not capacity | Rate limits under concurrent users; fallback exhaustion = outage | `lib/ai/models.ts` header; `APP_DAILY_MAX_CALLS` default 2000 (`lib/ai/daily-budget.ts`) | P1 | M | One paid primary + one paid fallback with DPA/ZDR; load test | yes |
| R10 | Cost | SerpApi 250/month free credits shared by all users; no per-user radar quota; owner pays all | One user burns the month; surprise bills | `lib/serp/budget.ts` (global guard), `app/api/radar/route.ts` (`assertBurst` only) | P1 | S | Per-user monthly quota; low-credit banner; spend dashboard | yes |
| R11 | Billing | No pricing, plans, payments or invoicing | Not sustainable; cannot gate heavy users | absent: no payment SDK in `package.json` | P1 | L | Decide model; Razorpay/Stripe; plan limits on `ai_usage_daily` | yes |
| R12 | Support | No support channel, help/FAQ or contact page | Pending/denied/error users have nowhere to go | absent: no `app/help`, `app/contact` | P1 | S | support@ mailbox, /contact, FAQ; link from `/pending` and error pages | yes (email) |
| R13 | Logging | Unstructured `console.*` (72 call sites), no request id; Sentry errors only | Hard to debug multi-step runs | grep; `lib/sentry-options.ts` header | P2 | M | JSON logger with requestId; Sentry sampling (no replay) | no |
| R14 | SLOs | No SLIs/SLOs, error budget or dashboard | Cannot say ready or degraded | absent | P2 | S | e.g. draft success >= 95% in 30 s, 99.5% availability from `draft_run` | yes (targets) |
| R15 | Runbooks | No runbooks, on-call, severity matrix, postmortem template | One person at 3 am | absent (comments only) | P2 | M | `RUNBOOK.md`: provider outage, DB restore, key leak, mail failure, quota exhaustion | no |
| R16 | Cron | Scheduled triggers always return 200; no heartbeat | Missed sync/alerts unnoticed | `netlify/functions/draft-alerts.mts`, `daily-sync.mts` | P2 | S | Heartbeat monitor; alert on misses | no |
| R17 | Config | No central env validation; silent behaviour change when vars missing | Misconfig = outage or silent degradation | `.env.example` (278 lines); `app/api/health/route.ts` is the only check | P2 | S | `lib/env.ts` zod schema, fail fast in prod | no |
| R18 | Rollout | No feature flags or kill switches (`tests/flags.test.mts` is regression tests, not flags); no canary | Cannot disable Radar/import quickly | grep lib = none | P2 | S | Env kill switches (radar, import, sign-up) | no |
| R19 | Rollback | Netlify rollback exists but schema is not reversible | Rolling code back past a `db:push` breaks | see R02 | P2 | S | Expand/contract rule in CONTRIBUTING | no |
| R20 | Release | No semver tags, CHANGELOG or release notes | Cannot correlate incidents to releases | `package.json` 0.1.0; no CHANGELOG.md | P3 | S | Tag releases; Sentry release = git SHA | no |
| R21 | SDLC | No evidence of branch protection, required review, CODEOWNERS or PR template (GitHub settings not verifiable from repo) | Unreviewed merges to main | `.github/` contents | P2 | S | Enable protection; CODEOWNERS | no |
| R22 | Testing | 71 offline suites but no coverage metric, no E2E in CI, no load or restore test | Unknown blind spots | `tests/`; `scripts/latency.mts` is manual | P2 | M | Coverage floor on critical libs; k6 on /api/draft with replay providers | no |
| R23 | Capacity | No capacity plan: Neon pool max 5/instance, Netlify concurrency, SerpApi 50/h, provider RPM | Unknown first bottleneck | `lib/db/index.ts:44` (`max: 5`) | P2 | M | Document per-dependency limits; load test | no |
| R24 | Data | Free-plan storage cap plus unbounded tables | Hard failure when full | see G06 | P2 | S | Size monitor; alert at 70% | no |
| R25 | Data | Most timestamps are `timestamp` without time zone | Subtle bugs across zones | `lib/db/schema.ts` (only 2 `withTimezone`) | P3 | M | Standardise `timestamptz` in a migration | no |
| R26 | Audit | `audit_log` is profile-edit history and is cascade-deleted with the user; no security audit trail (logins, exports, deletions, admin actions) | Forensics and accountability | `lib/db/schema.ts:421-435` | P2 | M | Separate `security_event` table retained N months | yes |
| R27 | Email | No account-deleted or password-changed notification | Takeover signal missing | `lib/auth/mail.ts` has verify, reset, operator mail only | P3 | S | Add notification mails | no |
| R28 | Docs | README is hackathon-oriented; no ops architecture, CONTRIBUTING or vendor register | Bus factor | `README.md`, `docs/hackathon/*` | P3 | S | Split user/ops docs | no |
| R29 | Perf | No performance budget, CWV or Lighthouse in CI; fonts from fontshare and Google | Unknown real-user performance | `next.config.ts` CSP font hosts | P2 | S | Lighthouse CI; self-host fonts | no |
| R30 | A11y | No automated or audited WCAG 2.2 AA coverage; no accessibility statement (basics present: skip link `app/layout.tsx:138`, `lang="en"`, ~150 aria attributes) | Exclusion; legal risk in some markets | no axe/pa11y in CI | P2 | M | axe in Playwright; manual pass; statement | no |
| R31 | SEO/crawl | `robots.ts` omits `/import /radar /resume /activity /admin`; no noindex header | Authed shells crawlable | `app/robots.ts:15` | P3 | S | Add paths + `X-Robots-Tag` | no |
| R32 | Caching | Every page dynamic; landing and future legal pages not static | Cost/latency on free plan | `force-dynamic` across pages | P3 | S | Static landing + legal | no |
| R33 | Signup policy | Open sign-up + manual approval does not scale; no waitlist, SLA or comms for pending users | Owner is the bottleneck; churn at `/pending` | `app/pending/page.tsx`; `lib/server/signup-notice.ts` | P2 | S | Invite codes or auto-approve under quota; approval SLA text | yes |
| R34 | Licensing | Dependency licence audit and NOTICE missing | Compliance if ever distributed | `LICENSE`, `COMMERCIAL-LICENSE.md` | P3 | S | `license-checker` in CI; NOTICE | no |
| R35 | Vendors | No vendor register (data sent, region, DPA status, exit plan) for Firecrawl, SerpApi, LLMs, Sentry, Neon, Netlify | Concentration and privacy | README Radar privacy section (only role/skill/city sent: good) | P3 | S | One-page vendor register | no |
| R36 | Cost | No spend dashboard or budget alert across providers | Surprise bills | budgets exist in code only | P2 | S | Weekly usage mail from `ai_usage_daily`; provider billing alerts | no |
| R37 | Radar | Radar sends role/skill/city to SerpApi but live mode is gated on one shared key and no per-user disclosure in UI | Transparency | README; `RADAR_PUBLIC_DEMO` in `app/radar/demo-gate.ts` | P3 | S | One-line disclosure in radar UI + notice | no |

**Counts: 72 gaps - P0: 4, P1: 20, P2: 33, P3: 15.**

---

## C. Questions for the owner (recommended default in brackets)

1. Public sign-up or invite-only at launch? [Invite codes + auto-approve under quota; manual approval for overflow.]
2. Legal entity for ToS/Privacy and a business address? [Sole proprietorship name for now; incorporate before billing.]
3. Grievance officer name and email? [You, grievance@yourdomain, 7-day acknowledgement, 30-day resolution.]
4. Which AI providers may receive resume PII? [Groq with ZDR + Fireworks; remove Gemini free key from the user path; Together/DeepInfra only after written no-train/no-retention.]
5. Will you pay for any AI provider, and what monthly cap? [One paid primary with a hard daily cap.]
6. Retention periods? [Run history 90 d, radar runs 30 d, serp cache 30 d, denied accounts 30 d, inactive 24 months with warning.]
7. Minimum age? [18+, attestation at sign-up.]
8. Pricing: free only, freemium or paid? [Free with quotas now; paid plan in Stage 2.]
9. Upgrade Neon and/or Netlify? [Neon Launch (7-day restore) now; Netlify after a load test.]
10. Sending domain and email vendor? [Own domain + Resend/Postmark; DMARC p=none then quarantine.]
11. Support channel? [support@ mailbox + FAQ page.]
12. Keep EEO/salary/work-authorisation fields? [Remove until a feature uses them.]
13. Availability target? [99.5% monthly, best-effort support, no formal SLA.]
14. EU users in scope? [Not targeted (say so in ToS); still honour export/erasure.]
15. Who is the backup admin with secret access? [One trusted person, read-only vault access.]

---

## D. Staged roadmap

**Stage 0 - blockers (1-2 weeks, before any real user):** S01 Next patch, S02 nodemailer, G03 provider allow-list/ZDR/drop Gemini free for PII, G01+G02 privacy notice, terms and consent record, G10 18+ attestation, G04 grievance contact, R12 support mailbox, R07 uptime monitor, S04 Dependabot + audit gate.

**Stage 1 - launch-ready (weeks 3-6):** R02 migrations, R01 backups and restore drill, R03 staging, R04 DB-backed CI + E2E smoke, R06 own-domain email, R08 alerting, R09+R10 paid provider and radar quotas, R05 background functions/plan, G05 incident plan, G06/G07 retention jobs, S06 CAPTCHA, G09/G11/G12/G13/G15/G16, S05/S07/S14, R14/R15/R17/R18/R33/R36.

**Stage 2 - scale:** R11 billing, S08 nonce CSP, S09 key rotation, S11 admin console, R13 structured logs/traces, R22/R23 load test and capacity, R26 security audit trail, R30 WCAG audit, S13 red-team corpus, S16 edge WAF, G17/G18, SBOM/provenance, canary releases.

---
Accuracy notes: "absent" claims were grep-checked across `app/ components/ lib/ auth.ts .github/ public/ netlify/`. Not verifiable from the repo (flagged): GitHub branch protection, Netlify/Neon dashboard settings, whether Sentry DSN and `TOKEN_ENC_KEY` are set in prod, and current vendor terms beyond the cited pages (re-verify before relying).
