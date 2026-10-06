# Findings digest (SerpApi India Hackathon 2026) — input to planning

Deadline: 2026-10-10 23:59 IST. Judging: idea, originality, technical complexity, usefulness, meaningful SerpApi use (core, not decoration).
Submission needs: public GitHub repo with setup steps, <3 min demo video, track (Knowledge & Public Interest / AI Agents), AI-tool disclosure.

## Current app (resumer-ai)
Next.js 16 / React 19 / Tailwind v4, Drizzle + Postgres, NextAuth (GitHub OAuth), Vercel AI SDK, live on Netlify FREE (30s function kill).
Flow: profile (GitHub/portfolio/resume import) -> paste job text or URL -> fit assessment -> tailored one-page ATS resume -> critic loop (8.5 bar, max 4 passes) -> PDF/DOCX; cover letter; interview prep; applications tracker.
Strengths: grounding gate (model proposes, code verifies, no invented facts), SSE draft console with Stop button, budgets/daily caps, provider fallback chain (Groq/Fireworks/Together/DeepInfra/Gemini), good a11y base.
No job discovery, no multi-step agent loop, no SerpApi code. One job per request.

## Constraints that shape the design
- Netlify free: ~12s usable model time per request. Agent runs MUST be many short client-driven steps (pattern: lib/sync/stepped.ts) with run state persisted in Postgres. Vercel gives 280s (VERCEL env) if ever moved.
- Groq rejects optional schema fields: every field in new zod schemas must be required.
- Per-draft cap 24 calls; daily 400 calls/user. Fan-out over N jobs must use a code-only prefilter, model only on top K.
- Netlify secrets scan: do not add NEXT_PUBLIC_* values. SERPAPI_API_KEY is server-only. Never log SerpApi URLs (key in query string).
- Any model-written text must pass acceptRewriteOrFallback grounding.

## UI verdict
Accessible but generic stock-SaaS: gray canvas, teal brand #0e7c86, rounded-lg bordered cards, default Tailwind scale, signed-out landing is a single centered card, create-next-app SVGs left in public/, no OG image, render-blocking Fontshare/Google font links, no loading.tsx anywhere.
Distinctive assets to keep: Instrument Serif display, "no invented facts" idea, check-mark motif.
Direction proposed: "ink on paper, red-pen edit" — warm paper (#F3EDE0 / dark #17150F), ink #1B1A17, vermilion proof-mark accent #C8341B (dark #FF6A4D), ink-blue #1F3A5F secondary, highlighter #F2D95C only as text background, serif display (Fraunces/Newsreader) + Instrument Sans/Inter Tight + mono for scores, square corners + hairline rules + § numbering instead of rounded cards, live resume-page artifact with margin notes/strike-throughs on landing, highlighter-sweep on matched keywords, one choreographed load, 150-250ms ease-out only.

## UX problems (ranked)
1 Resume editor loses edits silently (no autosave/beforeunload/undo); 2 every blur marks line edited and drops source trace (resume-editor.tsx ~347); 3 draft failure dead-ends, no retry; 4 progress has no step count/elapsed/spinner, hidden until first event; 5 fit card overload, decision at bottom, accusatory copy; 6 dashboard: three equal first-run paths, no recommended step; 7 owner-approval gate undisclosed, dead end; 8 importer review heavy, failure discards everything; 9 profile banner stacking; 10 no loading.tsx; 11 applications page thin (no sort/filter/notes/link); 12 export choices confusing.

## A11y fixes (ranked)
Focus ring suppressed on ~10 inputs (outline-none) incl. profile-assistant, status-select; contentEditable lacks role/label (prefer textarea); no skip link / main id; fonts via next/font; progress bars need role=progressbar; text-[11px] -> 12px min; theme-color meta should follow manual theme; editor padding at 360px; mobile nav max-height.

## SerpApi facts (from docs)
google_jobs: q (put city in q), location (or uule, exclusive), gl=in, hl=en, google_domain=google.co.in, next_page_token (10/page), lrad, no_cache, json_restrictor. chips/ltype deprecated.
Response: jobs_results[] {job_id (unstable), title, company_name, location, via, share_link, description, extensions[], detected_extensions{posted_at,schedule_type,salary?}, job_highlights[{title: Qualifications|Responsibilities|Benefits, items[]}], apply_options[{title,link}]}.
google_jobs_listing (q=job_id): now mostly company ratings (Glassdoor/Indeed/AmbitionBox); salary/apply_options/similar_jobs removed.
Credits: free 250/mo, 50/hr; only successful searches count; identical params cached 1h free; Account API free (account.json: total_searches_left). google_news: q, so=1, gl=in.
Dedupe by title+company. Salary often absent in India: regex the description (LPA).
MCP: mcp.serpapi.com (Bearer auth) — dev/exploration only; product uses REST.

## Product research (directional, vendor-biased sources)
Valued: JD-tailored keyword gap, ATS-parseable output, tracker. Distrusted: opaque ATS scores, keyword stuffing, mass auto-apply (hallucinated facts, spam flagging).
Agent UX: streaming timeline with sources, approval gates before outbound action, cancel/undo, show uncertainty.
India: freshers dominate (~45% of hires), LPA salary, projects-first resumes; Naukri/LinkedIn/Indeed/Google Jobs coverage varies.
Caveat: no verified ToS for scraping Indian portals; use Google Jobs via SerpApi only and link out.

## Architecture facts (code-verified by agent)
- Tables: profileRecord (atomic facts, jsonb data, reviewState), role, resumeSnapshot (document, jobRequirement jsonb, score), application (tracker; NO url column), draftRun, aiUsageDaily, syncJob. NO job-posting table. Schema change via `npm run db:push` (no migrations folder; loose SQL in scripts/).
- Flow = 3 SSE requests driven by components/draft-console.tsx: /api/draft/assess (runAssessment in lib/pipeline/run.ts) -> sealed token (lib/fit/token.ts, 1h, user-bound) -> /api/draft (runDraftPipeline) -> /api/draft/[id]/improve. SSE helper: lib/server/sse.ts eventStream.
- Job entry choke point: readJob in lib/pipeline/run.ts ~516-590 (URL scrape via Firecrawl 12s; blocked LinkedIn/Indeed/Glassdoor/ZipRecruiter; combineJobText 40k cap; extractJobRequirement = 1 AI call).
- Best seam: new lib/intake/search.ts beside searchWeb in lib/intake/scrape.ts; new route app/api/jobs/search; selecting a result sets jobInput to the posting DESCRIPTION TEXT (not URL) so it skips scrape and flows through existing assess/draft unchanged. Keep postings inside the seal or the draft re-reads the job (extra AI call).
- Pre-rank results with deterministic gatherFitFacts (lib/fit/assess.ts, no AI); never call extractJobRequirement per result.
- looksLikeUrl rejects anything with whitespace. Error detail must never reach the browser (use PipelineError.userMessage). Tests: `npm test` (tsx tests/run.mts, .mts), `npm run typecheck`, `npm run lint`.

## UI PLAN (from design Plan agent) — see docs/hackathon/UI-PLAN.md
