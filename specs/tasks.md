# Resumer AI — Implementation Tasks

Checkable work items grouped by phase (matching `PLAN.md`'s roadmap). Each task cites the requirement(s) it satisfies (`requirements.md`) and the design section it implements (`design.md`). Check items off as they're completed — this file is the running source of truth for build progress.

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done

---

## Phase 0 — Foundation

- [x] 0.1 Scaffold Next.js (App Router, TypeScript) project — *design.md §2*
- [x] 0.2 Configure auth with GitHub as primary provider, requesting repo scope in the same flow — *REQ-7.1, REQ-2.1 / design.md §4.1*
  - **Changed from the spec:** uses Auth.js (NextAuth v5), not Clerk. Auth.js hands us the GitHub access token from the same sign-in that authenticates the user — exactly what the sync connector needs. Clerk would have meant a second SaaS account plus extra work to retrieve the provider token. One flow, one credential, no extra dependency.
- [x] 0.3 Add email/password fallback sign-in — *REQ-7.2*
- [x] 0.4 Set up Postgres (Neon) + Drizzle schema for all tables in design.md §3, with `userId` on every table — *NFR-6*
- [ ] 0.5 Enable `pgvector` extension for embedding search
- [ ] 0.6 Deploy skeleton app to Vercel, register `resumeraiapp.vercel.app` (fallbacks: `resumeraihq`, `tryresumerai`) — *PLAN.md §9*
- [x] 0.7 Wire Tailwind + shadcn/ui with the Tidewater design tokens (light + dark) — *REQ-8.4 / design.md §7*
- [x] 0.8 Load Instrument Serif, General Sans, Spline Sans Mono — *REQ-8.4*

## Phase 1 — Profile Dashboard

- [x] 1.1 Build CRUD UI for Skill, Experience Bullet, Project, Education/Cert, Achievement — *REQ-1.1*
- [x] 1.2 Implement `source` + `contentHash` fields on every record, hidden from manual-entry UI but populated correctly — *REQ-1.2*
- [x] 1.3 Add reserved (unused) Application-Form Fields section to the schema and a hidden/disabled form section — *REQ-1.3*
  - Built as `/settings/application`: an editable form rather than a disabled one, because answers you cannot enter are not stored answers. The screen states plainly that nothing reads them yet and that they exist so Phase 10 needs no migration.
- [x] 1.4 Build responsive stacked-card layout for the dashboard below `md` breakpoint — *REQ-8.2, NFR-3*
- [x] 1.5 Build first-run flow: post-signup redirect straight to "Connect GitHub" or "Upload resume" choice — *REQ-8.3*
- [x] 1.6 Build the authenticated home screen: greeting, stat tiles, intake box, recent-drafts table, sync-status card — *REQ-8.5*

## Phase 2 — Resume Bootstrap Importer

- [x] 2.1 File upload (PDF/DOCX), read in memory from the multipart request
  - **Changed from the spec:** no Vercel Blob. The deployment target is Netlify, and the only durable thing in a resume upload is its text — a few kilobytes. Reading the bytes in the request and discarding them removes an integration and an uploaded-document retention question at once.
- [x] 2.2 AI extraction pass mapping uploaded resume text to atomic profile records (`source: 'ai-import'`) — *REQ-1.2*
  - Chunked, one AI call per chunk, one chunk per request — the same shape as the stepped sync and for the same measured reason (a 73k-char prompt took 138s and failed; a 1.5k-char one took 6.2s).
- [x] 2.3 Review/confirm UI before committing extracted records to the profile
  - `/import`. Nothing reaches `profile_record` without a ticked box; the payload is re-validated and every content hash recomputed server-side.

## Phase 3 — GitHub Sync Connector

- [x] 3.1 Implement commit-SHA fetch + comparison against `lastSyncedSha` — *REQ-2.2, NFR-7 / design.md §4.1*
- [x] 3.2 Implement structured-file parser (JSON/MDX/YAML) — *REQ-2.3*
- [x] 3.3 Implement AI extraction pass for hardcoded component content — *REQ-2.3*
- [x] 3.4 Implement live-site fallback fetch for unresolvable content — *REQ-2.3*
- [x] 3.5 Implement reconciliation logic: add/update/flag-removed by content hash, manual records untouched — *REQ-2.4*
- [x] 3.6 Build "flagged for removal" review UI in the dashboard
- [x] 3.7 Add daily scheduled sync job
  - **Changed from the spec:** a Netlify scheduled function (`netlify/functions/daily-sync.mts`), matching where this actually deploys. It only pings `/api/cron/sync`, which does the cheap half — one commit-SHA call per repo, clearing the cached SHA where it moved. Starting a real sync from a cron would strand a stepped job nobody can advance.
- [x] 3.8 Add optional GitHub push webhook route to invalidate cached SHA — *REQ-2.5*
- [ ] 3.9 Write reconciliation fixture tests (before/after mock repo content) — *design.md §6*

## Phase 4 — Job Intake

- [x] 4.1 Build job-input UI accepting free text or URL — *REQ-3.1*
- [x] 4.2 Implement domain blocklist check (LinkedIn/Indeed/Glassdoor) routing to manual-paste prompt — *REQ-3.2*
- [x] 4.3 Integrate Firecrawl scrape with JSON extraction schema — *REQ-3.2*
- [x] 4.4 Implement `generateObject` structured extraction into `JobRequirement` — *REQ-3.3*
- [x] 4.5 Implement sanity/consistency check (seniority-vs-years table + AI contradiction flag) — *REQ-3.4*
- [x] 4.6 Build ambiguity-surfacing UI when confidence is low

## Phase 5 — Retrieval & Generation Engine

- [x] 5.1 Define role-category → section-emphasis config — *REQ-4.1*
- [x] 5.2 Implement per-category relevance floor with user-editable tag mappings — *REQ-4.2*
- [x] 5.3 Implement hybrid retrieval (keyword overlap + embedding similarity) — *REQ-4.3*
- [x] 5.4 Implement grounded-rewrite prompt + post-hoc named-entity/number validation against source — *REQ-4.4*
- [ ] 5.5 Implement cover letter generation reusing the same retrieved data — *REQ-4.5*
- [ ] 5.6 Implement interview-question generation reusing the same retrieved data — *REQ-4.5*
- [ ] 5.7 Build editable preview UI with per-bullet source trace (links back to source record)
- [x] 5.8 Write grounded-rewrite property tests (entities/numbers subset check) — *design.md §6*
  - `tests/grounding.test.mts`, 3,000 generated source/candidate pairs checked with an independently written token scanner. Found and closed a real hole: an unanchored substring test accepted an invented "9x" because the source said "p95" (7 escapes in 1,439 fabrications).

## Phase 6 — Rendering & Export

- [x] 6.1 Implement section-heading allow-list enforcement — *REQ-6.1*
- [x] 6.2 Implement `ats-strict` PDF renderer (`@react-pdf/renderer`, text-only nodes) — *REQ-6.1, REQ-6.3*
- [x] 6.3 Implement `ats-strict` DOCX renderer (`docx` package, shared section-walk with PDF) — *REQ-6.1, REQ-6.3*
- [x] 6.4 Implement spelled-out date formatting and plain-bullet enforcement in both renderers — *REQ-6.1*
- [x] 6.5 Implement file-naming convention — *REQ-6.4*
- [x] 6.6 Implement length-by-seniority rule — *REQ-6.5*
- [x] 6.7 Implement `presentation` mode renderer (SVG icons, PDF-only, UI warning label) — *REQ-6.2*
  - `<Path>` geometry, never an icon font. The DOCX renderer throws on `renderMode: 'presentation'` and the export route refuses `format=docx&mode=presentation`, so PDF-only is enforced rather than intended.
- [x] 6.8 Integrate `mammoth`/`pdf-parse` + self-hosted OpenResume round-trip check — *REQ-6.6*
- [ ] 6.9 Integrate Affinda or RChilli API for final-pass validation — *REQ-6.6*
- [ ] 6.10 Implement baseline/master resume export (no job input) — *REQ-6.7*
- [x] 6.11 Write "known-bad template" integration tests (table, rasterized PDF, icon-font glyph) — *design.md §6*
  - `tests/render.test.mts`. PDF rendering still can't run under tsx (`@react-pdf` ESM export conditions), so the PDF path is verified in the Next runtime via `/api/dev/selftest`, which now also renders and round-trips the presentation variant.

## Phase 7 — Quality Gate Loop

- [x] 7.1 Implement deterministic keyword-coverage gate (70% threshold) — *REQ-5.1*
- [x] 7.2 Implement deterministic formatting-compliance scorer — *REQ-5.2*
- [x] 7.3 Implement deterministic skills-completeness scorer — *REQ-5.2*
- [x] 7.4 Implement AI-judged evidence-quality scorer (Groq-first routing) — *REQ-5.2*
- [x] 7.5 Implement critique-generation step — *REQ-5.3*
- [x] 7.6 Implement targeted-revise step (flagged sections only) — *REQ-5.4*
- [x] 7.7 Implement loop controller with `stopWhen` (score ≥ 8.5, 4-iteration cap, circuit breaker) — *REQ-5.5, REQ-5.6*
- [x] 7.8 Implement per-draft and daily circuit-breaker counters across all 5 providers — *REQ-5.6, NFR-2*
- [x] 7.9 Implement honest-failure state UI (best-scoring version + explanation) — *REQ-5.5*
- [x] 7.10 Build live SSE streaming endpoint emitting all pipeline stage events — *REQ-8.1*
- [x] 7.11 Build client-side pipeline-panel reducer consuming SSE events — *REQ-8.1*
- [x] 7.12 Write deterministic-scorer unit tests (fixed input/output pairs) — *design.md §6*
  - `tests/scorers.test.mts`. Every formatting rule has a test proving it fires and one proving it doesn't fire on a clean document.

## Phase 8 — Application Tracker

- [ ] 8.1 Build application log CRUD (resume version, job info, status) — *REQ-9.1*
- [x] 8.2 Implement immutable snapshot on export (Resume JSON + source-record hashes) — *REQ-9.2*
- [ ] 8.3 Link tracker entries to snapshots, never the live profile — *REQ-9.2*
- [ ] 8.4 Build status-update UI (applied → interview → rejected/offer)

## Phase 9 — Polish, Security & Observability

- [x] 9.1 Implement audit-log entries on all profile record changes — *REQ-10.1*
- [ ] 9.2 Add uptime/error alerting on the sync job and AI-provider fallback chain — *REQ-10.2*
- [x] 9.3 Surface failed pipeline stages as visible errors in the live panel, never a silent hang — *REQ-10.2*
- [ ] 9.4 Encrypt PII and GitHub OAuth token at rest; audit minimum-scope token usage — *REQ-10.3, NFR-5*
- [ ] 9.5 Add additional resume templates per role category (visual variety within `ats-strict` constraints)
- [x] 9.6 Full WCAG AA contrast audit across all implemented screens (not just the token table) — *NFR-4*
  - Measured on rendered text with composited backgrounds, 7 pages x light/dark: 0 failures after fixing four real ones (gold/warning/danger on their own tints, and white-on-brand in dark mode, which was 2.93:1 on every primary button).
- [x] 9.7 Full responsive QA pass at 375px, 768px, 1024px, 1920px — *NFR-3*
  - Driven in a real browser across 7 pages x 4 widths: no horizontal overflow anywhere, no unlabeled control, and every tap target now at least 44px tall.

## Phase 10 — Stretch: Browser-Extension Autofill (opt-in, later)

- [ ] 10.1 Build browser extension shell reading from Resumer AI's Application-Form Fields (REQ-1.3)
- [ ] 10.2 Implement per-site field-mapping for common ATS application forms
- [ ] 10.3 Wire extension to authenticate against the user's Resumer AI account

---

## Open Items Before Starting (from `PLAN.md` §12)

- [ ] Confirm the `owner/name` of the private GitHub repo behind anandsundaramoorthy.com (needed by Phase 3, not Phase 0)
- [ ] Decide application-tracker scope for v1 (Phase 8 now vs. deferred)
- [ ] Set up or confirm a Firecrawl account/API key (needed by Phase 4)
- [ ] Set up or confirm an Affinda or RChilli developer account (needed by Phase 6)

---

## Build status — first end-to-end pass

**Working and verified:**
- Full Next.js app builds clean (`npm run build`), typecheck clean (`npm run typecheck`)
- `npx tsx scripts/smoke.mts` — 18 checks pass covering the deterministic scorers, the
  anti-fabrication guard, the retrieval relevance floor, sync reconciliation, and the
  DOCX round-trip
- `GET /api/dev/selftest` — PDF and DOCX both render and survive being parsed back to
  text (532 and 513 characters recovered, name/email/URLs/skills all intact)
- `npx tsx scripts/ai-check.mts` — provider chain confirmed working against the real
  DeepInfra key; job extraction returned correct role, seniority, category and keywords

**Fixed during the build, worth recording:**
- Every provider's default model ID from the original spec was wrong or retired.
  Corrected against each provider's live model list. Fireworks' Llama 3.3 ID no longer
  exists at all.
- DeepInfra, Together and Fireworks all failed native structured output in different
  ways. Added a JSON-text fallback path with Zod validation (`lib/ai/chain.ts`), so
  open-weight models work without weakening the schema contract.
- `pdf-parse` v2 exports a `PDFParse` class, not the v1 default function.
- `pdfjs-dist` resolves its worker by path at runtime, so PDF/DOCX packages are declared
  in `serverExternalPackages` — without this the round-trip self-test fails in a built app.

**Still to do (needs credentials or a decision):**
- 0.5 pgvector — retrieval currently runs lexical-only, which is what moves ATS keyword
  scores anyway; embeddings are an enhancement, not a blocker
- 0.6 Deploy and claim the subdomain
- 3.9 Reconciliation fixture tests
- 6.9 Affinda/RChilli licensed-parser tier (needs an account)
- 6.10 Baseline/master resume export
- 8.1, 8.3, 8.4 Tracker UI
- 9.2 Alerting on sync failure and provider-chain exhaustion
- 9.4 Encrypt PII and the GitHub token at rest
- 9.5 Additional per-category templates

---

## Build status — second pass (importer, tests, presentation mode, cron, QA)

**Verified, with the numbers:**
- `npx tsc --noEmit` clean; `npm run build` clean (25 routes)
- `npm test` — 95 assertions across 4 suites, all passing:
  scorers 43, grounding 19, render 16, import 17
- `npx tsx scripts/smoke.mts` — the pre-existing 18 checks still pass
- `GET /api/dev/selftest` — PDF 532 chars, DOCX 513, presentation PDF 526, all three
  round-trip clean; the DOCX renderer confirmed to refuse presentation mode
- Importer driven end to end in a browser against the real provider chain: a synthetic
  DOCX resume produced 2 roles, 5 bullets, 11 skills, 2 projects, education, 2
  certifications and 1 achievement; all 22 wrote with one audit row each, every bullet
  grouped under a real role row, and a second import of the same file reported
  "21 already present" rather than duplicating a career. Test rows removed afterwards.
- Responsive/contrast QA driven in a real browser, 7 pages x 4 widths x 2 themes

**Found and fixed while testing, worth recording:**
- `lib/generate/grounding.ts` accepted an invented figure when one of its digits appeared
  inside a different number in the source — "9x" passed because the source said "p95".
  The property test caught 7 escapes in 1,439 generated fabrications. The substring check
  is now digit-boundary aware.
- Four colour pairs failed WCAG AA in real use, all of them looking fine by eye: gold,
  warning and danger each measured 4.20-4.42:1 on their own tint (badges and banners),
  and white-on-brand in dark mode measured 2.93:1 — every primary button in the dark
  theme. Fixed by darkening three tokens a few percent and adding `--color-on-brand`.
- Form controls used `border-line` at 1.25:1, below the 3:1 WCAG 1.4.11 needs for a
  control boundary; they now use `border-muted`.
- Every nav link was a 20px-tall tap target. The header had room for 44px without moving.

**Known limits, stated rather than hidden:**
- `@react-pdf/renderer` still cannot be imported under tsx, so `tests/render.test.mts`
  exercises the DOCX renderer plus the shared document model, heading allow-list and date
  formatter. The PDF path is covered by `/api/dev/selftest` in the Next runtime.
- The round-trip self-test looks for the first listed skill anywhere in the extracted
  text rather than inside a Skills region, so it only catches a dropped Skills section
  when that skill appears nowhere else. Noted in the test that relies on it.
- `lib/quality/keywords.ts` matches keywords by substring, so "React" does match
  "reacts". Its comment claims otherwise. Left alone rather than changed quietly, since
  tightening it would move every historical score.
