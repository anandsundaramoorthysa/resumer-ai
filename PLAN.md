# Personal Resume Engine — Architecture Plan

> **Historical.** This is the plan the project started from, kept for the reasoning behind
> the decisions. Several things here were never built or were replaced: sign-in is Auth.js
> with GitHub, Google and passwords rather than Clerk, retrieval is lexical rather than
> pgvector embeddings, files are rendered on demand rather than stored in blob storage, and
> a LinkedIn export importer exists after all. `specs/` and `README.md` describe what the
> app actually does; `STEWARD.md` covers the profile assistant.

**Goal:** One system that stores your complete professional profile once, accepts *any* job description format (formal JD, LinkedIn post text, a forwarded blurb, a job title alone), and generates a role-tailored, ATS-safe resume (PDF + DOCX) — without inventing facts and without you retyping anything per application.

Decisions locked in from our discussion:
- **Data source of truth:** manual profile dashboard, **kept fresh by one connector** — your private GitHub repo behind `anandsundaramoorthy.com` (source files + live site as fallback). No LinkedIn scraping, no LinkedIn export step — dropped entirely in favor of this single, safe source, since that repo already carries ~90% of your details and is under your control.
- **Sync timing: on-demand, right before every draft — not just on a schedule.** Every time you start a resume draft, the system first re-pulls the repo (cheap check: compare latest commit SHA to the SHA it last synced; only re-parse if it changed), reconciles your stored profile against it — **additions, edits, and removals** — then generates from the now-current profile. A background cron sync can *also* run for general freshness, but the pre-draft check is the one that guarantees the resume is never built from stale data.
- **Output:** PDF + DOCX, both ATS-safe, generated from one shared data model so they never drift apart.
- **Scope:** built multi-tenant from day one (real accounts, `userId` on every row) even though only you use it now.
- **AI:** provider-agnostic via the Vercel AI SDK's model abstraction — routing order **Gemini → Groq → DeepInfra → Together AI / Fireworks AI**, swappable model strings, not separate code paths. Groq specifically must always be pointed at whichever of its models is currently live (Groq retires model IDs regularly — a stale hardcoded one silently starts failing), which matters most for the scoring loop below since that's where speed counts. Optionally route through Vercel AI Gateway later for unified fallback/observability across all five.
- **Quality gate:** a resume is never hitting a "done" state on the first pass alone — it's scored, and if it's not good enough, the system diagnoses why and fixes it, then re-scores, in a loop, before you ever see the output. Full mechanics in Section 6.

---

## 1. The core idea: atomic, tagged facts — not paragraphs

The single biggest failure mode for "AI resume tailoring" is a model paraphrasing a vague blob of career history and quietly inventing details. To avoid that, your profile isn't stored as prose — it's stored as **atomic units**, each one independently taggable and retrievable:

- **Skill** — name, category (language / framework / tool / soft skill), proficiency, years, last-used date
- **Experience bullet** — one accomplishment per record: action, metric/impact, tech/skills used, role it belongs to, date range
- **Project** — name, description, stack tags, links, impact metrics, `source` field (`manual` or `github-sync`) + a content hash, so the sync step only ever touches records it owns and never silently edits something you typed by hand
- **Education / Certification** — standard fields
- **Achievement** — awards, publications, talks
- **Application-form fields (reserved now, unused until Phase 10)** — work authorization status, visa sponsorship needs, EEO/voluntary-disclosure answers, salary expectation, notice period. These are exactly what an autofill feature (Section 9) needs later, and retrofitting them onto the schema after the fact means re-touching every reconciliation rule that already exists by then — cheaper to reserve the fields now while the schema is still young, even though nothing reads them until Phase 10.

Every bullet and project carries a **tag list** (skills + keywords it demonstrates). This turns resume generation into a retrieval problem: given a job's required keywords, rank and select the atomic units that best match, then have the AI *tighten the phrasing* — never author new claims. This is what makes "ATS-friendly *and* accurate" possible instead of "ATS-friendly but exaggerated."

## 2. Architecture overview

Every draft request starts with a **sync-and-reconcile** step, not just a read of whatever's already stored:

```mermaid
flowchart TB
    You([You click "Draft resume"]) --> Input[Paste job info\nJD / LinkedIn post / anything]

    subgraph Sync["Pre-Draft Sync (runs every time)"]
        direction TB
        S1[Fetch latest commit SHA\nfrom private GitHub repo]
        S2{SHA changed since\nlast sync?}
        S3[Pull changed source files\n+ live site as fallback]
        S4[Parse: direct read of structured\nfiles, AI extraction over\nhardcoded component content]
        S5[Reconcile vs stored profile\nby content hash:\nADD new · UPDATE changed · flag REMOVED]
        S1 --> S2
        S2 -->|yes| S3 --> S4 --> S5
        S2 -->|no| Skip[Skip re-parse, profile\nalready current]
    end

    Input --> Extract[AI: Structured Extraction\nrole, seniority, required/preferred\nskills, ATS keywords, tone]
    S5 --> DB[(Postgres\nAtomic, tagged records\ntagged by source: manual / github-sync)]
    Skip --> DB

    Extract --> Retrieve[Hybrid Retrieval\nkeyword overlap + embedding similarity\nover DB records]
    DB --> Retrieve
    Retrieve --> Rewrite[AI: Grounded Rewrite\nrephrase selected bullets to mirror\nJD language — no new facts]
    Rewrite --> Assemble[Resume JSON\nsection order picked by role category]
    Assemble --> ScoreCheck{Score >= 8.5/10?\nkeywords + format +\nevidence + skills coverage}
    ScoreCheck -->|yes| Render[Render Engine]
    ScoreCheck -->|no, capped at 4 tries| Critique[AI: Critique\npinpoint exactly what's low & why]
    Critique --> Revise[AI: Targeted Revise\nfix only the flagged bullets/sections]
    Revise --> ScoreCheck
    Render --> PDF[PDF export]
    Render --> DOCX[DOCX export]
```

**Why check the SHA first:** re-parsing the whole repo (and paying for an AI extraction pass over hardcoded content) on every single draft would be wasteful and slow. Comparing the latest commit SHA to the one you last synced is a single free API call — if nothing changed, skip straight to generation with the profile you already have.

**Reconciliation policy:** additions and updates to `github-sync`-sourced records apply automatically (low risk — it's your own repo, and generation always happens right after, so you see the result immediately). A record GitHub-sync no longer sees gets flagged, not silently deleted — shown to you as "no longer found in source, remove from profile?" the next time you're in the dashboard, so nothing you rely on disappears from a parsing mistake. Manually-entered records (`source: manual`) are never touched by sync, regardless of what changes upstream.

## 3. Handling "undefined anything" as job input

A single **Job Intake** step normalizes every format into one structured object before anything else happens:

1. User pastes text (JD, LinkedIn post, one-line title) **or a URL**.
2. If it's a URL, a fallback chain fetches it — this is the part most tools get wrong, so it's worth being explicit about, confirmed by checking how the space handles it today:
   - **Try Firecrawl's scrape API first**, with a JSON schema for the fields we want (title, company, responsibilities, required/preferred skills, seniority). Firecrawl renders JS and rotates proxies server-side, and one schema works across almost any company career page or ATS portal (Greenhouse, Lever, Workday, Ashby, etc.) — one integration covers the long tail instead of writing a scraper per site.
   - **LinkedIn, Indeed, and Glassdoor are the known exception** — they run aggressive anti-bot systems (Datadome/PerimeterX) that block scraping outright, Firecrawl included. Detect the domain up front and skip straight to the next step for these rather than wasting a call.
   - **Fallback: ask the user to paste the text.** If the scrape fails or the domain is a known-blocked one, the UI just asks you to paste the posting text instead — no dead end, just a one-click nudge back to the always-reliable path.
   - Either path lands in the same place: plain text, ready for extraction. The rest of the pipeline never knows or cares whether it came from a scrape or a paste.
3. AI call with a structured-output schema (Zod + `generateObject`) extracts:
   - role title, seniority, department/function (SEO, Full Stack, AI Engineer, PM, etc.)
   - required skills, preferred skills, responsibilities
   - explicit ATS keywords/phrases (exact terms recruiters' filters scan for)
   - company/industry context, tone (startup vs. corporate) for wording style
4. This structured `JobRequirement` object is what every downstream step consumes — it no longer matters whether the source was a formal JD or a scrappy LinkedIn caption.
5. **Sanity check before it ever reaches retrieval.** A `generateObject` call can extract a coherent-looking `JobRequirement` from garbage input or a self-contradictory posting (e.g. "0-2 years experience, must have 10 years of Kubernetes") and hand it downstream with total confidence — the pipeline would then quietly produce a confidently wrong resume with no signal anything was off. A lightweight consistency check on the extracted object (years-of-experience vs seniority level, requirement count vs input length, internal contradictions) flags ambiguous or low-quality extractions back to you instead of silently proceeding.

## 4. Resume generation logic

- **Role-based section weighting:** a role-category → section-emphasis map (e.g., SEO → tools/metrics-heavy bullets and a "Technical Skills: SEO & Analytics" section; AI Engineer → projects and ML stack first; PM → leadership/stakeholder outcomes first; Full Stack → balanced project + stack). This is deterministic config, not AI guesswork, so output is consistent and explainable.
- **Cross-domain relevance floor, not just reordering.** Section weighting alone doesn't stop an SEO-targeted resume from surfacing a Kubernetes bullet just because it scored decently on embedding similarity — across role families this different (SEO vs Full Stack vs AI Engineer vs PM), an irrelevant-but-similar-scoring bullet actively hurts rather than just diluting. Retrieval applies a per-role-category relevance floor on tags (a bullet tagged purely with off-category skills gets excluded outright, not just ranked lower), and you can hand-tune the category tag mappings in the dashboard rather than trusting pure auto-computed similarity to draw that line for something this consequential.
- **Retrieval:** hybrid of (a) exact/fuzzy keyword overlap against your tags — this is what actually moves ATS keyword-match scores — and (b) embedding similarity for softer semantic matches your tags might miss, filtered through the relevance floor above. Combine into one ranked list, cap to the space a resume allows.
- **Grounded rewrite:** system prompt constrains the model to *only* rephrase/reorder selected source bullets to echo the JD's terminology (e.g., your tag says "Postgres," JD says "relational databases" → wording can bridge that), and explicitly forbids introducing metrics, tools, or claims not present in source data.
- **Output:** one canonical `Resume` JSON (sections → items → text + source-bullet reference), used identically by both renderers.

## 5. ATS-safe rendering — two modes off one schema

Researched this rather than assuming: icons give **zero** ATS-parsing benefit and carry real risk on both implementation paths — image icons can disrupt the linear text-extraction order around whatever text sits next to them, and icon fonts (the classic "phone/envelope glyph" approach) render as a blank box, `?`, or nothing if the font isn't embedded, sometimes taking the adjacent phone number or email down with it. The one legitimate exception: a resume you're certain only a human will ever open as a PDF (emailed directly, handed over at an event) can carry a few simple icons safely, since no parser touches that file.

So rather than a single fixed template, the renderer has **two modes from the same `Resume` JSON**:

**`ats-strict` (default — anything going through a portal/upload)**
- Single column, no text-boxes/images/skill-bars/icons of any kind. **Correction after checking primary sources, not just resume-advice sites:** "columns always break parsing" is overstated as a blanket technical fact — Textkernel's own developer docs (the parsing engine behind SuccessFactors/iCIMS and one of the most widely-licensed engines in the market) state it explicitly handles columnar layouts, and an independent 36-template test against that engine found zero column-caused failures. The real risk is *tables and absolutely-positioned/graphic-heavy layouts* (Canva-style templates), which genuinely do scramble reading order on the fragmented tail of legacy/lower-end parsers still in production (older Taleo instances, some government systems). Single-column stays the default because it's the safe lowest-common-denominator across that whole fragmented market, not because two-column is provably broken everywhere — worth knowing the difference between "safest default" and "hard technical constraint."
- Contact info as plain text labels: `Email: you@... | Phone: ... | Portfolio: anandsundaramoorthy.com | GitHub: github.com/...`
- Name and contact block live in the document body, never a Word header/footer — many ATS parsers skip header/footer regions entirely, so a resume with contact info trapped there can parse as anonymous
- Hyperlinks kept, but the visible text is the actual readable URL, not a label or icon — `anandsundaramoorthy.com` as both link text and href, so if a parser strips hyperlink metadata (common), the visible text alone still carries the full info
- **Dates spelled out, never numeric:** `Jan 2022 – Present`, never `01/2022` or `1/22`. This one is a documented failure mode, not folklore — Textkernel's own docs flag that numeric dates like `5/1/09` parse differently depending on which locale the engine guesses (US MM/DD vs EU DD/MM), silently scrambling your work history's date range.
- **Bullet character is plain `•` or `-` only** — decorative/symbol bullets (►◆★➤, Wingdings-style glyphs) can render as a box, a `?`, or cause the parser to skip or merge the line. Converged finding across independent sources; a one-line rule, easy to just enforce.
- **Section headings pulled from an explicit allow-list per section**, not free text — e.g. Experience accepts "Experience," "Work Experience," "Professional Experience," or "Employment History," but never something like "My Journey." Recognized synonyms are fine everywhere; the actual risk is creative/non-standard headers.
- **PDFs must have a genuine embedded text layer, never a rasterized/flattened image of the page** — `@react-pdf/renderer` produces real embedded text by construction, but this assumption gets verified explicitly in the round-trip self-test rather than just trusted, since a rasterized PDF is unreadable to every parser regardless of any other rule here.
- **Default to DOCX when a portal accepts either format** — no source in the research turned up a real downside to DOCX, and it's generally at least as reliable to parse as a text-native PDF; PDF stays available for anywhere that requires it or for the `presentation` mode below.
- Generated as both PDF and DOCX from the same schema regardless of which one a given portal ends up requiring — this is the version that ever gets uploaded anywhere

**`presentation` (opt-in — direct human sends only)**
- Same content, small monochrome SVG icons allowed next to contact fields (not icon-font glyphs — real embedded vector images, so there's no missing-font failure mode), placed beside the plain text rather than replacing it
- **PDF only, never DOCX** — a DOCX is far more likely to get re-parsed or ingested by *something* downstream, so it stays in the strict template always
- Clearly labeled in the UI ("for direct/email sends — don't upload this one to a portal") so it's never used where it shouldn't be

Shared rules regardless of mode:
- Arial or Times New Roman, 10–12pt, standard section headings ("Experience," "Education," "Skills")
- Reverse-chronological order
- **A dedicated Skills section is non-negotiable, not optional styling** — parsers weight terms found there more heavily than the same term buried in a bullet, so every JD-matched skill goes in both places: once in the Skills list (exact JD terminology) and again woven into the experience bullet that demonstrates it
- **Bullets carry evidence, not just keywords** — the grounded-rewrite prompt (Section 4) is constrained to a tool/action + scale + outcome shape (e.g. "Optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 40%"), because keyword-stuffed bullets with no supporting evidence now score *worse*, not just neutrally, on modern parsers
- **Length by seniority:** one page for early-career/individual-contributor roles, two pages permitted where your experience and the role norm (senior/PM/leadership) genuinely warrant it — a deterministic rule off your profile's total experience, not left to the AI to decide per draft
- **File naming is part of the output, not an afterthought:** exports are auto-named `FirstName_LastName_RoleOrCompany.pdf/.docx` — generic names like `resume_final_v2.pdf` read poorly to both recruiters and some ATS ingestion rules
- **PDF:** `@react-pdf/renderer` (exact layout control, works well on Vercel Functions)
- **DOCX:** the `docx` npm package, built from the *same* `Resume` JSON — so PDF and DOCX are two renderers over one data source, never hand-maintained separately
- **ATS round-trip self-test:** immediately after generating each file, parse it back with a plain text extractor (`mammoth` for DOCX, `pdf-parse` for PDF) and verify your name/email/phone/portfolio-URL/GitHub-URL/skills all extract cleanly, in order, and as readable text (not icon glyphs or garbled Unicode) — this catches a broken template (a stray icon, a table an edit accidentally introduced, a link that lost its visible URL text) before you ever send a resume out with hidden formatting damage, rather than trusting the renderer blindly
- **ATS score panel, not just a coverage %:** combine keyword coverage against the job's extracted list, the formatting checks above, and an evidence-quality check (does each bullet have a metric/outcome, not just a tool name) into one score with a breakdown — closer to what Rezi/Jobscan surface, so you have one number plus specifics to act on before applying, not a black box

## 6. Quality gate: score → critique → revise, in a loop, before you ever see it

You said you don't know how to define "make sure the score is good" — so here's a concrete, checkable definition instead of a vague promise, plus the loop that enforces it.

**The score (out of 10) is a weighted blend of things that are actually checkable — not one AI vibe-check.** **Correction from the research pass:** the first draft of this rubric weighted keyword coverage at 40%, which directly contradicts the plan's own stated philosophy just above it — that keyword-stuffed bullets without evidence "score worse, not just neutrally" — and external critique of Jobscan-style tools backs that up: high keyword-match percentages correlate weakly with actual interview outcomes, so keyword coverage functions better as a floor to clear than a target to maximize. Fixed rubric:

| Sub-score | Weight/type | How it's checked |
|---|---|---|
| Keyword coverage | **Gate, not weighted** — must clear 70% or the draft doesn't pass regardless of other scores | Deterministic, code only — exact/fuzzy match of the job's extracted ATS keywords against what's actually present across the Skills section + bullets. |
| Formatting compliance | 30% | Deterministic — every `ats-strict` rule from Section 5 either holds or it doesn't: single column, no icons, contact in body, hyperlink visible text, standard fonts, **spelled-out dates, plain bullet characters, and section headings matching the allow-list**. |
| Evidence quality | 30% (raised from 20%) | AI-judged — does each bullet actually carry a tool/action + scale + outcome, or is it a bare keyword drop? This is the one sub-score that needs semantic judgment, so it's the only one that costs a model call. |
| Skills-section completeness | 40% | Deterministic — every keyword the job requires that you *genuinely have* somewhere in your profile is pulled into the dedicated Skills section, not left buried in a bullet. |

Keyword coverage clearing its 70% gate is a precondition for scoring at all — if it doesn't clear, the draft is an automatic fail regardless of how the other three land, and the critique step's first job is always closing that gate before optimizing anything else. Once the gate is cleared, the 8.5/10 is computed purely from formatting compliance, evidence quality, and skills completeness. This keeps the loop from doing exactly what the plan warns against — chasing a keyword percentage at the expense of resumes that actually read as evidence-backed.

Three of the four checks are pure code — instant, free, zero hallucination risk. Only "evidence quality" needs a model, which is what keeps each loop iteration cheap.

**The loop:**
1. Generate the resume (Section 4).
2. Check the keyword-coverage gate first. Below 70% → straight to a targeted revise pulling in the missing-but-genuinely-held keywords, no need to compute the rest yet.
3. Score the three weighted sub-scores. **≥ 8.5 → done**, hands off to the editable preview.
4. **< 8.5 → critique step**: pinpoints exactly which sub-score(s) are low and *why*, tied to specific bullets — e.g. "Skills section is missing 'Terraform' and 'CI/CD' — both required, both already present in your GitHub-synced project bullets, just not pulled into Skills" or "bullet #3 names a tool but has no scale or outcome."
5. **Targeted revise step**: fixes only the flagged items — re-runs retrieval/rewrite for those specific bullets/sections against your real profile data, never touches what already scored well. Keeps each pass cheap and stops the resume drifting further from source truth with every iteration.
6. Re-score. Repeat, **capped at 4 iterations total**.
7. **If still under 8.5 after 4 tries (or the keyword gate genuinely can't be cleared with real data), stop and say so honestly** — show the best-scoring version actually achieved (not necessarily the last one), plus exactly what's capping it. Most commonly that's a genuine gap between your real experience and the JD's requirements, and that is the one thing no amount of rewriting is allowed to close, because the no-fabrication rule from Section 1 holds even when it's costing you score. A wording problem gets fixed by the loop; a real gap gets reported to you instead of invented.
8. **Hard circuit breaker independent of the score condition:** a per-draft cap on total AI calls/tokens across all five providers, and a daily spend ceiling, both enforced regardless of whether the score has converged — so a stuck loop or a bad extraction retrying across the entire Gemini→Groq→DeepInfra→Together/Fireworks chain can't silently rack up cost. Hitting this cap surfaces the same honest-failure message as step 7.

**Why Groq specifically fits here:** the loop runs several small AI calls per draft (mostly the evidence-quality judge and the targeted revises), so speed matters more in this one part of the system than anywhere else. That's the reason for inserting Groq into the routing chain right after Gemini — its inference is fast enough to make a 3-4 iteration loop feel instant instead of like a wait, as long as it's always pointed at a currently-live model rather than one Groq has since retired.

This generator → critic → reviser loop (sometimes called self-refine or reflection) is the "modern technology" that actually earns the 8.5 bar: the deterministic checks make it trustworthy (no talking it out of a real formatting violation), the corrected rubric stops it from optimizing the wrong thing, and the hard cap plus the honest-failure path stop it from either looping forever, silently overspending, or fabricating its way to a passing score.

**Grounded in real parsers, not folklore — and where that claim honestly stops.** There's no single "ATS methodology" to certify against — the market is fragmented across Workday, Greenhouse, Lever, iCIMS, Oracle Taleo, SAP SuccessFactors, and more, with no unified standard. But most of these platforms don't build their own text-extraction engine — they license one from a small set of specialist vendors (Textkernel/Sovren, RChilli, Affinda, HireAbility), so the actual parsing logic is far more concentrated than the number of ATS brand names suggests. The formatting rules in Section 5 target genuine mechanical failure modes shared across that whole set (broken reading order from columns/tables, undecodable icon-font glyphs, skipped header/footer regions) — not repeated blog folklore. To validate for real rather than assume, the round-trip self-test (Section 5) gets a three-tier structure: **(1) free, every iteration** — `mammoth`/`pdf-parse` for basic extractability, plus **OpenResume** (open-source, self-hostable, purpose-built for ATS-readability testing) as a zero-cost parsing-engine-shaped check that runs on every single quality-gate loop iteration without incurring API cost; **(2) paid, periodic/final only** — once a draft clears the quality gate, one call to a real licensed parsing API (Affinda or RChilli, both have developer tiers) confirms it correctly maps your name/email/phone/skills/experience/dates into labeled fields — a genuinely stronger signal than "the text is extractable," since it's exercising an engine of the same lineage several real ATS platforms actually run in production, reserved for the final pass rather than every loop iteration since it costs money. The honest limit: neither tier can guarantee behavior on a specific company's Workday instance, since large platforms layer their own logic on top and that's not something we can test from outside — what we *can* guarantee is that the resume passes the best available real-world proxy, on top of formatting rules chosen for mechanical reasons rather than convention.

## 7. Data ingestion / "auto-update" pipeline

| Source | Mechanism | When it runs |
|---|---|---|
| Manual dashboard | You add/edit atomic records directly; always wins, sync never overwrites these | Whenever you edit |
| Private GitHub repo (portfolio) | GitHub OAuth — the **same sign-in you use to log into the app** (Section 9) requests repo-read scope in that one flow, so there's no separate PAT to generate or rotate. Reads structured content files directly where they exist, runs an AI extraction pass over component source where content is hardcoded; live site fetched as a fallback for anything not resolvable from source | **Every pre-draft sync check** (SHA-gated) + a daily background cron, **plus an optional GitHub webhook on push** so a portfolio update can invalidate the cached SHA immediately instead of waiting for your next draft or the daily cron |
| Existing resume(s) | Upload old resume PDF/DOCX → AI extracts atomic records to bootstrap the profile fast | One-time, to seed the profile before the repo connector exists |

## 8. Tech stack

- **Framework:** Next.js (App Router) + TypeScript
- **DB:** Postgres (Neon, via Vercel Marketplace) + Drizzle ORM, `pgvector` extension for embedding search, `userId` on every table
- **Auth:** Clerk or NextAuth — real accounts from day one
- **AI:** Vercel AI SDK v6, model-agnostic across your five confirmed providers — **Gemini, Groq, DeepInfra, Together AI, Fireworks AI** (`GEMINI_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`, `DEEPINFRA_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`) — routing order Gemini → Groq → DeepInfra → Together/Fireworks (try primary → fall back on error/rate-limit); optional Vercel AI Gateway later for one unified integration across all five
- **Job-URL scraping:** Firecrawl (scrape API, JSON-schema extraction) as the primary path, with the LinkedIn/Indeed/Glassdoor-blocked domains routed straight to manual paste
- **File storage:** Vercel Blob (uploaded resumes/exports, generated PDF/DOCX)
- **Background jobs:** Vercel Cron for GitHub sync
- **Rendering:** `@react-pdf/renderer` (PDF), `docx` (DOCX)
- **ATS self-test:** `mammoth` (DOCX → text) and `pdf-parse` (PDF → text) plus **OpenResume** (self-hosted, free) for every loop iteration; a real parsing-engine API (Affinda or RChilli) for the paid, periodic/final-only stronger check that fields map correctly, not just that text comes out
- **Quality-gate loop:** built on the AI SDK's multi-step/agentic loop primitives (tool-calling steps with a stop condition) rather than hand-rolled retry code — score/critique/revise as steps, `stopWhen` the score clears 8.5 or the 4-iteration cap is hit

## 9. Product identity, UI/UX & login

**Name and URL.** The product is **Resumer AI**. Checked actual subdomain availability rather than assuming — `resumer-ai.vercel.app` and `resumerai.vercel.app` are both already claimed by unrelated apps (a URL summarizer and someone else's waitlist page, respectively). **`resumeraiapp.vercel.app` is unclaimed** and is the confirmed choice to register at deploy time; `resumeraihq.vercel.app` and `tryresumerai.vercel.app` are also open, as backups in case it gets taken between now and Phase 0. (A Vercel subdomain is claimed at actual project deployment, so this is the best available check ahead of time, not an absolute guarantee — first thing to confirm when Phase 0 runs `vercel deploy`.)

**Login.** Clerk, as already planned in Section 8, with **GitHub as the primary sign-in method** — deliberately the same OAuth flow that grants the repo-read scope for Section 7's sync connector, so signing in and connecting your portfolio repo is one action, not two separate credentials to manage. Email/password as a fallback sign-in method for whenever GitHub OAuth itself is unavailable.

**The interactive part you asked for — showing the pipeline as it runs, not a spinner.** Every stage in Section 2's flowchart becomes a visible, real-time step in the UI rather than a black-box wait, streamed to the browser as it actually happens (Server-Sent Events over a plain Node.js route — no Edge runtime needed for this on Vercel):

- "Checking your portfolio for updates..." → resolves to "Found 2 updates: added *Project X*, updated your DeepInfra experience bullet" or "You're already up to date" (Section 2's sync step)
- "Understanding the job..." → resolves to a short summary chip: role, seniority, top 5 extracted keywords (Section 3)
- "Finding your most relevant experience..." → resolves to a count: "Selected 8 bullets, 3 projects" (Section 4's retrieval)
- "Drafting your resume..." (Section 4's grounded rewrite)
- "Scoring against ATS criteria..." → live iteration readout as the quality gate actually runs: "Attempt 1: keyword gate passed, 7.2/10 → revising evidence in 2 bullets" then "Attempt 2: 8.7/10 ✓" (Section 6) — this is the one place where showing the real mechanism *is* the trust-building feature, not just decoration, since Section 6 exists specifically because "just trust the AI" isn't good enough
- "Finalizing your files..." → resolves to the round-trip self-test result (Section 5/6) before handing off to the editable preview

This reuses infrastructure that already has to exist (the pipeline itself, the AI SDK's streaming primitives) rather than being extra work bolted on for show — the stages are real, not a fake progress bar.

**Responsive, not just "technically works on mobile."** Tailwind CSS + shadcn/ui, mobile-first breakpoints — the profile dashboard (data-dense, many fields) gets an actual mobile layout (stacked cards, not a shrunk desktop table), and the live pipeline view above is exactly as legible on a phone as a desktop, since checking a resume's progress from your phone while multitasking a job search is a completely normal use case for this product.

**Color palette — Tidewater, chosen after comparing three options as local HTML mockups of the actual app-home screen (not a marketing page), then refined against measured WCAG contrast rather than assumed.** Checking the original hexes against the WCAG AA text-contrast minimum (4.5:1 for normal text) turned up two real failures: the gold accent measured 3.24:1 on white, and the warning color measured 3.34:1 — both were quietly relying on always appearing bold/large, which wasn't guaranteed. Both darkened to versions that clear AA with real margin, and gold is now split into a text-safe shade and a separate brighter shade reserved for backgrounds/decoration only, so the same token is never accidentally used somewhere it'd fail:

| Token | Light mode | Dark mode | Use | Measured contrast (light, on its typical surface) |
|---|---|---|---|---|
| `paper` (background) | `#F5F6F8` | `#14161C` | page background | — |
| `ink` (text) | `#14161C` | `#EAEBEF` | primary text | ~17:1 on paper |
| `brand` (primary accent) | `#0E7C86` (deep teal) | `#2BA6AF` | button fills, primary actions | ~4.95:1 (white text on it) |
| `brand-dark` | `#0A5F67` | `#6FC9D0` | links, active nav, small brand-colored text | ~7.4:1 on white |
| `gold` (text-safe) | `#96691D` — **darkened from `#B8862B`, which measured 3.24:1 and failed AA** | `#D8AE5E` | labels/values that need the gold identity as actual readable text | ~4.84:1 on white |
| `gold-bright` (decoration only) | `#C9922F` | `#E0BC7C` | large stat numbers, icon fills on tint backgrounds — never small standalone text | n/a (large/decorative only) |
| `success` | `#197A42` — darkened from `#1F8A4C` (measured 4.38:1, failed) | `#4FBE81` | score ≥ 8.5, sync succeeded | ~5.4:1 |
| `warning` | `#A85F12` — darkened from `#C97A1F` (measured 3.34:1, failed) | `#E0994A` | score iterating, sync flagged something | ~4.9:1 |
| `danger` | `#C43D3D` (already safe) | `#E58080` | score capped-out failure, sync/AI-provider error | ~5.1:1 |
| neutral scale | `#E4E6EB` → `#5B6270` (borders/muted text) | `#2B2F3A` → `#9BA1AC` | borders, secondary text, dividers | muted text ~5.7:1 on paper |

Semantic colors (success/warning/danger) stay separate from the brand/gold accents so the ATS score panel's pass/fail states read unambiguously regardless of brand styling elsewhere.

**Typography — replaced entirely, not reused from any AI-tool default.** **Instrument Serif** for headings (editorial character, regular weight only — hierarchy comes from size/spacing rather than faking a bold this face doesn't have), **General Sans** (Fontshare) for body/UI text, and **Spline Sans Mono** for anything tabular — ATS scores, keyword chips, commit hashes, file names. Deliberately not IBM Plex, Inter, or Space Grotesk, since those are exactly the faces that make a product read as generic-AI-tool rather than its own thing. Tabular figures on every score/percentage display so numbers align in place as the quality-gate loop updates live.

A working comparison of this exact palette + type system applied to the real app-home screen (greeting, stats, the resume-intake box, recent drafts, sync status) lives at `mockups/tidewater.html` in the project folder — open it directly in a browser.

## 10. What you didn't ask for but should be in scope

Going through how existing tools in this space (Rezi, Teal, Simplify, Jobscan) actually get used, plus where a system like this tends to bite you later if skipped, here's what I'm folding in that wasn't in the original ask:

1. **Cover letter generation** — same retrieval + grounded-rewrite pipeline, one more output. Nearly every serious competitor bundles this, and you get it almost for free once resume generation exists.
2. **Editable preview before export** — the generated resume opens in an editable view, not a direct download. For something this high-stakes, you should be able to nudge a sentence before it goes out, not just trust the model.
3. **Source trace per bullet** — each generated line remembers which profile record it came from, surfaced as a hover/click in the preview. Makes the output auditable instead of a black box, and makes it obvious if something ever *did* drift from your real data.
4. **A baseline/master resume export** — one general-purpose, non-tailored version for cold applications, referrals, or "send me your resume" asks where there's no JD to tailor against.
5. **Duplicate/conflict resolution** — if the same skill or achievement is captured both manually and via GitHub sync, the assembly step dedupes rather than printing it twice.
6. **PII and credential security** — the DB holds your name/phone/email/address plus a GitHub OAuth token scoped to repo-read (Section 9). Encrypted secrets, minimal scope, auth-gated access throughout — worth stating explicitly since you flagged wanting this multi-user-ready eventually, and this is the part that actually matters once it is.
7. **Application tracker as a feedback loop, not just a log** (extends Phase 8) — pairing each sent resume version + job info with an outcome (applied/interview/rejected/offer) is what eventually lets you notice patterns in what's working, not just what was sent.
8. **Immutable snapshot of what was actually sent.** The pre-draft sync keeps updating your live profile, but without this, a fact changing later leaves no record of what a recruiter actually saw for a given application. Each export snapshots the final Resume JSON plus the source-record hashes it was built from, and the tracker row references that snapshot, not the live (and by-then-different) profile.
9. **Interview-question prep, generated almost for free.** The Job Intake step (Section 3) already extracts structured `JobRequirement` data and matches it against your profile — role-specific likely interview questions are a small reuse of that same data, not a new pipeline, and every serious competitor in this space (Kickresume, Rezi) bundles it.
10. **Explicitly deferred, not overlooked:** salary/comp research per role and a networking/referral CRM (Teal's approach) both came up in competitor research. Given you're spanning role families with very different comp bands, salary context could matter eventually — but both are lower priority than the above and are call-outs for later consideration, not gaps in the current build.
11. **Flagged, not committed — browser-extension autofill:** Simplify's core value is autofilling application-form fields from your profile, which matters a lot at the volume you're applying. It's a genuinely bigger scope item (a browser extension + per-site field mapping), so I'd treat it as a post-MVP phase you opt into once the core generator is solid, not part of the first build — which is also why Section 1's profile schema reserves the application-form fields (work authorization, visa sponsorship, EEO answers, salary expectation, notice period) now, even though nothing uses them until then.
12. **A real first-run experience, not an empty dashboard.** Phase 1 otherwise leaves you looking at a blank profile with nothing in it — research into where SaaS products actually lose people confirms weak onboarding is one of the biggest early drop-off causes, and "reach the aha moment fast" applies just as much to a personal tool as a multi-user product, since a blank state is just as discouraging either way. Fix: right after first login, prompt straight into "Connect your GitHub portfolio" (Section 9's unified OAuth) or "Upload an existing resume" (Section 8's bootstrap importer) — the profile has real content within the first couple of minutes instead of an empty form staring back at you.
13. **Observability on the parts that can silently fail.** The pipeline depends on a GitHub sync, five AI providers with fallback, and Firecrawl for job-URL scraping — the same research into common early-stage SaaS failures flags exactly this pattern (things breaking silently, discovered from a user complaint rather than a monitor) as one of the most common gaps. Fix: uptime/error alerting on the sync job and the AI-provider fallback chain (Vercel's own observability or a lightweight external check), and a visible in-app status rather than a silent hang when a stage fails — the live pipeline view from Section 9 already has to show stage-by-stage progress, so a failed stage surfacing there as an actual error state, not a stuck spinner, is a small extension of work that already exists.
14. **A lightweight audit trail.** Every sync reconciliation and profile edit gets a timestamped record of what changed and from where (manual edit vs. GitHub sync vs. AI extraction) — useful for your own trust in the auto-update pipeline day to day, and becomes a real requirement rather than a nicety if this ever does open up to other users.

## 11. Phased roadmap

- **Phase 0** — Scaffold Next.js app; Clerk login with GitHub as primary provider (Section 9's unified sign-in + repo-scope grant); DB schema; Vercel project setup; deploy to confirm the `resumeraiapp.vercel.app` subdomain; base Tailwind/shadcn theme wired to the Section 9 color/type tokens
- **Phase 1** — Profile dashboard (manual CRUD for skills/experience/projects/education), mobile-responsive from the start; first-run flow prompts straight into GitHub connect or resume upload instead of an empty screen
- **Phase 2** — Old-resume bootstrap importer (upload existing resume → AI-extracted starting profile)
- **Phase 3** — GitHub repo sync connector: structured-file parser + AI extraction pass for hardcoded content + SHA-gated pre-draft sync + optional push webhook + reconciliation (add/update/flag-removed), with dedupe against manual records
- **Phase 4** — Job Intake: Firecrawl-first URL scraping with manual-paste fallback, structured extraction from whatever text results, sanity/consistency check on the extracted `JobRequirement`
- **Phase 5** — Retrieval (with the per-role-category relevance floor) + grounded-rewrite generation engine, canonical Resume JSON, cover letter as a second output of the same pipeline, editable preview with per-bullet source trace, interview-question prep as a small reuse of the same extracted data
- **Phase 6** — ATS-safe PDF + DOCX renderers (`ats-strict` mode: spelled-out dates, plain bullets, heading allow-list), auto file-naming, ATS round-trip self-test (OpenResume free tier + Affinda/RChilli paid tier), full ATS score panel (keyword gate + formatting + evidence quality + skills completeness), baseline/master resume export, `presentation` mode (icons, PDF-only) as a later add-on within this phase
- **Phase 7** — Quality-gate loop: keyword-coverage gate → score → critique → targeted revise → re-score, capped at 4 iterations, hard spend/call circuit breaker, honest-failure reporting when either cap is hit; **the live streaming pipeline UI from Section 9 is built alongside this phase**, since it's the phase that first has real, multi-step, non-instant work worth showing
- **Phase 8** — Application tracker: resume version + job info + outcome (applied/interview/rejected/offer) per application, each pinned to an immutable snapshot of the resume + source-record hashes at send time
- **Phase 9** — Polish: template variety per role category, multi-provider fallback ordering, PII/secrets hardening for eventual multi-user use, uptime/error alerting on the sync and AI-fallback chain, audit trail on profile changes
- **Phase 10 (stretch, opt-in later)** — Browser-extension autofill for application forms, using the reserved fields from Section 1

*(GitHub sync moved up to Phase 3 — it's now the primary way your profile ever becomes ATS-generation-ready, so it needs to exist before Job Intake/generation are useful for anything beyond manually-entered data. The quality-gate loop is its own phase, Phase 7, because it wraps Phases 5-6 rather than being part of either — it needs both the generation engine and the renderer's format-compliance checks to already exist, and it's the natural point to build the live pipeline UI since that's the first phase with real multi-step work worth watching.)*

## 12. Open questions for you

1. **Repo details:** the `owner/name` of the private GitHub repo behind anandsundaramoorthy.com, so Phase 3 can be scoped concretely. (Not needed until Phase 3 — won't block Phase 0/1.)
2. Want the **application tracker** (Phase 8) in scope now, or purely resume generation for the first pass?
3. Do you already have (or want to set up) a **Firecrawl** account/API key for Phase 4, or should I look at alternatives when we get there?
4. Do you already have a **Groq** API key (`GROQ_API_KEY`) to add alongside the other four, or still need to create one?
5. For the real-parser validation tier: okay to sign up for a free/trial developer account with **Affinda** or **RChilli** when we reach that part of Phase 6, or do you have a preference/existing account with either?
~~Name/URL~~ — confirmed: **`resumeraiapp.vercel.app`**.
~~Color palette/typography~~ — confirmed: **Tidewater** (teal/gold, refined for verified WCAG AA contrast) with **Instrument Serif / General Sans / Spline Sans Mono**, per Section 9 and `mockups/tidewater.html`.
~~Which two providers besides Gemini and DeepInfra~~ — confirmed: **Gemini, Groq, DeepInfra, Together AI, Fireworks AI**.

---

Ready to start on **Phase 0** whenever you say go.
