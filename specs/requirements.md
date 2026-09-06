# Resumer AI — Requirements Specification

This is the formal, traceable requirements spec derived from `PLAN.md` (which stays in place as the narrative rationale — the "why," the research, the rejected alternatives). This document is the "what," written to be checkable: every requirement has a stable ID and acceptance criteria in EARS form (WHEN/IF ... THE SYSTEM SHALL ...). `design.md` maps each requirement to a technical solution; `tasks.md` maps each design section to buildable, checkable work.

**Product summary:** Resumer AI maintains one canonical profile of a user's professional history as atomic, tagged facts; keeps that profile current via a GitHub-portfolio sync that runs before every draft; accepts a job description in any form (pasted text, a URL, a LinkedIn post); and generates an ATS-safe, tailored resume that is scored, critiqued, and revised in a loop before ever being shown to the user. Single user at launch (`userId`-scoped from day one for later multi-tenancy).

---

## Non-Functional Requirements

- **NFR-1 (Streaming latency):** WHEN a pipeline stage completes THEN the system SHALL push the corresponding UI update to the client within 500ms.
- **NFR-2 (Cost containment):** THE SYSTEM SHALL enforce a per-draft AI call/token budget and a daily spend ceiling across all five providers, independent of whether the quality-gate score has converged (see REQ-5.6).
- **NFR-3 (Responsive):** THE SYSTEM SHALL render all screens usably from 375px to 1920px+ viewport width, with no horizontal scroll and no loss of functionality on any breakpoint.
- **NFR-4 (Accessibility):** ALL text and UI-component color pairs SHALL meet WCAG 2.1 AA contrast (4.5:1 normal text, 3:1 large text/UI components) — verified by calculation, not assumed (see `design.md` §7 for the measured Tidewater token values).
- **NFR-5 (Data security):** THE SYSTEM SHALL encrypt PII and the GitHub OAuth token at rest and gate all access behind authentication.
- **NFR-6 (Multi-tenant readiness):** EVERY database table SHALL include a `userId` column from initial implementation, even while single-user.
- **NFR-7 (Sync efficiency):** WHEN the pre-draft GitHub sync check finds no commit-SHA change THEN the system SHALL skip re-parsing entirely, adding no more than one API call of latency.
- **NFR-8 (No fabrication — cross-cutting):** THE SYSTEM SHALL NOT introduce any skill, metric, tool, or claim into generated output that is not traceable to a stored profile record, under any circumstance, including when a quality-gate score is below threshold (see REQ-5.5).

---

## Module 1 — Profile Data Model

**REQ-1.1 Atomic record types.** As a user, I want my profile stored as discrete, taggable facts, so that generation can retrieve and cite exactly what's relevant instead of paraphrasing an opaque blob.
- WHEN a profile record is created THEN the system SHALL store it as one of: Skill, Experience Bullet, Project, Education/Certification, Achievement, or Application-Form Field.
- Each Skill/Bullet/Project record SHALL carry a tag list of skills/keywords it demonstrates.

**REQ-1.2 Provenance tracking.** WHEN a record is created or updated THEN the system SHALL store its `source` (`manual` | `github-sync` | `ai-import`) and a content hash.
- IF a record's `source` is `manual` THEN the sync process (Module 2) SHALL NOT modify or delete it under any condition.

**REQ-1.3 Reserved autofill fields.** THE SYSTEM SHALL include work-authorization status, visa sponsorship, EEO/voluntary-disclosure answers, salary expectation, and notice period as profile fields from initial schema design, unused until Phase 10 (Module 11).

---

## Module 2 — GitHub Portfolio Sync

**REQ-2.1 Unified OAuth.** As a user, I want one sign-in to both authenticate me and grant repo-read access, so that I never manage a separate PAT.
- WHEN a user signs in with GitHub THEN the system SHALL request repo-read scope in that same OAuth flow.

**REQ-2.2 Pre-draft sync gate.** WHEN a user starts a new resume draft THEN the system SHALL fetch the portfolio repo's latest commit SHA and compare it to the last-synced SHA BEFORE running retrieval.
- IF the SHA is unchanged THEN the system SHALL skip re-parsing and proceed with the existing profile (NFR-7).
- IF the SHA has changed THEN the system SHALL pull changed files and re-parse before proceeding.

**REQ-2.3 Parsing strategy.** WHEN parsing repo content THEN the system SHALL read structured data files (JSON/MDX/YAML) directly, and SHALL run an AI extraction pass over component source files where content is hardcoded, falling back to the live site for anything unresolvable from source.

**REQ-2.4 Reconciliation.** WHEN parsed content is compared against stored `github-sync` records THEN the system SHALL: add new records automatically, update changed records automatically (matched by content hash), and flag (not delete) records no longer found in source for user review.
- THE SYSTEM SHALL NOT apply any reconciliation action to `manual`-sourced records (REQ-1.2).

**REQ-2.5 Push-triggered invalidation.** WHERE a GitHub webhook is configured, WHEN a push event fires on the portfolio repo THEN the system SHALL invalidate the cached SHA immediately rather than waiting for the next draft or daily cron.

---

## Module 3 — Job Intake

**REQ-3.1 Format-agnostic input.** As a user, I want to paste anything — a JD, a LinkedIn post, a URL, a bare title — and have it work, so that I never have to reformat a posting before using the tool.
- THE SYSTEM SHALL accept free text or a URL as job input with no format precondition.

**REQ-3.2 URL resolution chain.** WHEN a URL is submitted THEN the system SHALL attempt a Firecrawl scrape with a JSON extraction schema FIRST.
- IF the domain matches a known-blocked list (LinkedIn, Indeed, Glassdoor) THEN the system SHALL skip the scrape attempt and prompt the user to paste the text instead.
- IF a Firecrawl scrape fails for any other domain THEN the system SHALL fall back to the same manual-paste prompt.

**REQ-3.3 Structured extraction.** WHEN plain text job input is available (scraped or pasted) THEN the system SHALL extract a structured `JobRequirement` object: role title, seniority, department/category, required skills, preferred skills, responsibilities, explicit ATS keywords, company/industry context, and tone.

**REQ-3.4 Sanity check.** WHEN a `JobRequirement` is extracted THEN the system SHALL run a consistency check (years-of-experience vs. seniority, requirement count vs. input length, internal contradictions).
- IF the check flags low confidence or contradiction THEN the system SHALL surface this to the user before proceeding to retrieval, rather than silently continuing.

---

## Module 4 — Retrieval & Grounded Generation

**REQ-4.1 Role-category section weighting.** WHEN assembling a resume THEN the system SHALL apply a deterministic role-category → section-emphasis mapping (e.g., SEO, Full Stack, AI Engineer, PM) to section order and emphasis.

**REQ-4.2 Cross-domain relevance floor.** WHEN retrieving candidate bullets/projects for a given role category THEN the system SHALL exclude records that fall below a per-category relevance floor on tags, rather than merely ranking them lower.
- THE SYSTEM SHALL allow the user to hand-tune category tag mappings rather than relying solely on computed similarity.

**REQ-4.3 Hybrid retrieval.** THE SYSTEM SHALL rank candidate records using both exact/fuzzy keyword overlap against the extracted `JobRequirement` and embedding similarity, combined into one ranked list, filtered by REQ-4.2's floor, and capped to the space a resume allows.

**REQ-4.4 Grounded rewrite — no fabrication.** WHEN rewriting a selected bullet THEN the system SHALL only rephrase or reorder existing source content to mirror the job's terminology.
- THE SYSTEM SHALL NOT introduce a metric, tool, skill, or claim absent from the source record (NFR-8).

**REQ-4.5 Secondary outputs.** WHERE a resume has been generated, THE SYSTEM SHALL be able to produce a cover letter and a set of likely interview questions by reusing the same retrieved/matched data, without a separate extraction pass.

---

## Module 5 — Quality Gate Loop

**REQ-5.1 Keyword-coverage gate.** WHEN a resume draft is produced THEN the system SHALL check keyword coverage against the job's extracted ATS keywords as a pass/fail gate at a 70% threshold, evaluated BEFORE the weighted sub-scores.
- IF coverage is below 70% THEN the system SHALL trigger a targeted revise pulling in missing-but-genuinely-held keywords before computing the rest of the score.

**REQ-5.2 Weighted scoring.** WHEN the keyword gate is cleared THEN the system SHALL compute a 0–10 score as: formatting compliance 30%, evidence quality 30%, skills-section completeness 40%.
- Formatting compliance, keyword coverage, and skills completeness SHALL be computed deterministically (no AI call).
- Evidence quality SHALL be computed via a single AI-judge call per iteration.

**REQ-5.3 Critique step.** IF the computed score is below 8.5 THEN the system SHALL generate a critique identifying which sub-score(s) are low and why, tied to specific bullets/sections.

**REQ-5.4 Targeted revise.** WHEN a critique is produced THEN the system SHALL re-run retrieval/rewrite ONLY for the flagged bullets/sections against real profile data, leaving already-adequate content untouched.

**REQ-5.5 Iteration cap and honest failure.** THE SYSTEM SHALL cap the score→critique→revise loop at 4 iterations total.
- IF the score remains below 8.5 (or the keyword gate cannot be cleared with real profile data) after 4 iterations THEN the system SHALL stop, present the best-scoring version actually achieved, and state plainly what is capping the score, WITHOUT relaxing REQ-4.4's no-fabrication constraint to force a pass.

**REQ-5.6 Circuit breaker.** THE SYSTEM SHALL enforce a hard per-draft cap on total AI calls/tokens across all five providers, and a daily spend ceiling, independent of the score/iteration state (NFR-2).
- IF either cap is hit THEN the system SHALL surface the same honest-failure state as REQ-5.5.

---

## Module 6 — Rendering & Export

**REQ-6.1 `ats-strict` formatting rules.** WHEN rendering in `ats-strict` mode (the default) THEN the system SHALL enforce: single column; no tables/text-boxes/images/skill-bars/icons; contact info as plain text labels in the document body (never a header/footer); hyperlink visible text equal to the actual URL; Arial or Times New Roman, 10–12pt; section headings drawn from an explicit per-section allow-list; spelled-out month names for all dates (never numeric); plain `•`/`-` bullet characters only.

**REQ-6.2 `presentation` mode.** WHERE a user explicitly opts in, THE SYSTEM SHALL offer a `presentation` render with small embedded-SVG icons (never icon-font glyphs) beside contact text, PDF-only, visibly labeled in the UI as not for portal upload.

**REQ-6.3 Dual-format generation.** WHEN a resume passes the quality gate THEN the system SHALL generate both PDF (`@react-pdf/renderer`, verified embedded text layer, never rasterized) and DOCX (`docx` package) from the same `Resume` JSON.

**REQ-6.4 File naming.** THE SYSTEM SHALL name exported files `FirstName_LastName_RoleOrCompany.pdf`/`.docx`, never a generic name.

**REQ-6.5 Length by seniority.** THE SYSTEM SHALL cap resume length to one page for early-career/IC roles and permit two pages only where the profile's total experience and role seniority warrant it, as a deterministic rule.

**REQ-6.6 Round-trip self-test.** WHEN a file is generated THEN the system SHALL verify it via (a) `mammoth`/`pdf-parse` basic extractability plus OpenResume (free, every iteration), and (b) one call to a licensed parsing API (Affinda or RChilli) on the final passing draft only.
- IF the self-test finds garbled text, missing contact fields, or non-readable characters THEN the system SHALL treat this as a render failure and re-render rather than deliver the file.

**REQ-6.7 Baseline export.** THE SYSTEM SHALL support generating a non-tailored, general-purpose "baseline" resume from the profile without a job input.

---

## Module 7 — Identity & Access

**REQ-7.1 Primary sign-in.** THE SYSTEM SHALL use Clerk with GitHub as the primary sign-in provider, combined with REQ-2.1's repo-scope grant in one flow.

**REQ-7.2 Fallback sign-in.** THE SYSTEM SHALL offer email/password sign-in as a fallback when GitHub OAuth is unavailable.

**REQ-7.3 Tenant isolation.** THE SYSTEM SHALL scope every query by the authenticated user's `userId` (NFR-6), even while only one account exists.

---

## Module 8 — UI/UX

**REQ-8.1 Live pipeline visualization.** WHEN a resume draft is running THEN the system SHALL stream each real pipeline stage (sync check, job understanding, retrieval, drafting, quality-gate iterations with live score, finalization/self-test) to the UI as it happens via Server-Sent Events over a Node.js route.
- THE SYSTEM SHALL NOT display a stage as "in progress" or "done" unless that stage is actually executing or has actually completed (no simulated progress).

**REQ-8.2 Responsive layout.** THE SYSTEM SHALL provide a purpose-built mobile layout for the profile dashboard and the live pipeline view (not a shrunk desktop layout), per NFR-3.

**REQ-8.3 First-run flow.** WHEN a user completes their first sign-in THEN the system SHALL prompt directly into "Connect your GitHub portfolio" or "Upload an existing resume," rather than presenting an empty profile dashboard.

**REQ-8.4 Design tokens.** THE SYSTEM SHALL implement the Tidewater color palette and Instrument Serif / General Sans / Spline Sans Mono typography exactly as specified in `design.md` §7, including the light/dark token sets.

**REQ-8.5 Home dashboard contents.** THE SYSTEM SHALL show on the authenticated home screen: a greeting, quick stats (resumes drafted this period, average ATS score, applications tracked, profile last-synced time), a job-intake input, a recent-drafts list (role, company, category, score, date, download actions), and a portfolio-sync status card.

---

## Module 9 — Application Tracker

**REQ-9.1 Application logging.** THE SYSTEM SHALL record, per application: the resume version used, extracted job info, and an outcome status (applied/interview/rejected/offer), updatable by the user.

**REQ-9.2 Immutable snapshot.** WHEN a resume is exported for an application THEN the system SHALL snapshot the final `Resume` JSON plus the source-record hashes it was built from, and the tracker entry SHALL reference this snapshot rather than the live (and possibly later-changed) profile.

---

## Module 10 — Security, Observability & Operations

**REQ-10.1 Audit trail.** WHEN any profile record is created, changed, or reconciled THEN the system SHALL log a timestamped entry recording what changed and its source (manual/github-sync/ai-import).

**REQ-10.2 Failure observability.** THE SYSTEM SHALL alert on sync-job failures and on exhaustion of the AI-provider fallback chain (Gemini→Groq→DeepInfra→Together/Fireworks), and SHALL surface any failed pipeline stage as a visible error state in the live pipeline view (REQ-8.1), never a silent hang.

**REQ-10.3 Credential scope.** THE SYSTEM SHALL request the minimum GitHub OAuth scope needed (repo-read only) and SHALL encrypt it at rest (NFR-5).

---

## Requirement Index (for `tasks.md` cross-referencing)

| Module | Requirement IDs |
|---|---|
| 1. Profile Data Model | REQ-1.1 – REQ-1.3 |
| 2. GitHub Sync | REQ-2.1 – REQ-2.5 |
| 3. Job Intake | REQ-3.1 – REQ-3.4 |
| 4. Retrieval & Generation | REQ-4.1 – REQ-4.5 |
| 5. Quality Gate Loop | REQ-5.1 – REQ-5.6 |
| 6. Rendering & Export | REQ-6.1 – REQ-6.7 |
| 7. Identity & Access | REQ-7.1 – REQ-7.3 |
| 8. UI/UX | REQ-8.1 – REQ-8.5 |
| 9. Application Tracker | REQ-9.1 – REQ-9.2 |
| 10. Security & Ops | REQ-10.1 – REQ-10.3 |
| Cross-cutting | NFR-1 – NFR-8 |
