# Job Radar: SerpApi multi-agent plan (source of truth for build agents)

Principle: code decides and fetches; LLM runs only in Planner (1 fast call) and Tailor (existing), plus existing critic. All zod fields REQUIRED (Groq rejects optional); encode "absent" as "", 0 or [].
Netlify free = 30s kill: each run step is ONE short request (<=8.5s), state persisted in Postgres, client loops `advance`. Same code runs on Vercel/localhost.

## Agents
A Planner (LLM, 1 call, fast tier; rules-only fallback from titles) -> 2-3 queries + location. Reuses generateStructured/draftCallOptions.
B Searcher (code, SerpApi google_jobs). C Ranker (code, deterministic, top K=5; synthetic JobRequirement from a skill lexicon via lib/quality/keywords; uses gatherFitFacts; NO per-result AI call).
D Employer-Intel (code: google_jobs_listing ratings + google_news, top 2-3 companies, opt-in). E Market-Signal (code: LPA p25/median/p75, top in-demand skills, gap skills).
F Tailor = existing runAssessment/runDraftPipeline with the selected posting's DESCRIPTION TEXT as jobInput. G Critic = existing 8.5 loop.
Human gates: G1 after Planner (edit/remove queries before credits spent); G2 after Rank+Intel (user picks posting). Never auto-apply; Apply opens applyLinks in new tab.

## Shared schemas (lib/serp/types.ts; zod; all required)
PlanSchema {queries:[{q,why}].max(3), location, seniority: intern|entry|mid|senior|lead|unknown, rationale}
Posting {key (sha1 lower(title)|lower(company)), title, company, location, via, description, applyLinks:[{title,link}], postedAt, scheduleType, salaryLpa:{min,max,source: serp|regex|none}, highlights:string[], serpJobId, fromQuery:number}
RankedPosting {key, score, coveragePct, matched:string[], missing:string[], reason}
EmployerIntel {company, rating (0=unknown), ratingSource, reviewsCount, headlines:[{title,source,link,date}]}
MarketSignal {sampleSize, salaryLpa:{p25,median,p75,n}, topSkills:[{skill,pct,held:boolean}], gapSkills:string[]}

## SerpApi usage
google_jobs: q="<role> <city>" (city in q), gl=in, hl=en, google_domain=google.co.in, json_restrictor, page 1 only (next_page_token = "more" button, 1 credit). Never send no_cache except explicit Refresh.
google_jobs_listing: q=serpJobId, ratings only; parser must tolerate absence (rating 0). google_news: q=company, so=1, gl=in, top 3.
Run = 2 searches + Intel top 2 (listing+news) = ~6 credits default. Dedupe key sha1(title|company); job_id unstable, never identity.
Salary: prefer detected_extensions.salary else regex on description (X-Y LPA / lakhs / ₹N per month x12/1e5 / CTC); reject outside 1-200 LPA; mark source ("est. from description").
Cache table serp_cache {key sha256(engine+sorted params minus api_key) PK, engine, payload jsonb, fetchedAt}; TTL 1h jobs, 24h news/listing.
Budget (lib/serp/budget.ts): free account.json check memoized 5 min in DB; block if total_searches_left<10 or hour count>=45; per-user 3 runs/day, 12 credits/run. On block -> replay mode with visible "credits low, showing cached sample" banner, never silent.
Replay mode: if SERPAPI_API_KEY unset or SERP_MODE=replay, read fixtures/serpapi/*.json (SERP_MODE=record captures real ones). Every replay result labeled "sample data". Judges can run the whole flow without a key.
Security: key server-only, no NEXT_PUBLIC_, never log URLs, strip api_key from all error strings, 6s per-call timeout (timeout = warn event).

## State machine / protocol (mirror lib/sync/stepped.ts and app/api/sync/route.ts)
Tables (new file lib/db/schema-radar.ts, re-exported by one line in lib/db/schema.ts; apply with npm run db:push):
agentRuns {id, userId cascade, status running|awaiting|done|error|cancelled, phase, step int, totalSteps int, message, state jsonb (plan,postings,ranked,intel,market,selectedKey), events jsonb append-only cap 60, creditsUsed int, mode live|replay, error, createdAt, updatedAt; index(userId,createdAt)}; serpCache.
Phases: plan -> (awaiting G1) -> search:q0, search:q1 -> rank -> intel:company0.. -> market -> (awaiting G2) -> done.
API: POST /api/radar start; POST {runId, expectStep} advance one step (idempotent guard); {runId,action:'approve',queries?}; {runId,action:'select',key}; {runId,action:'cancel'}; GET ?runId= status (no id = latest non-terminal). Polling + JSON events (no SSE for radar). Failure of one query/company = warn event + skip; only plan failure or total search failure is hard error. POST /api/radar/handoff returns {jobText} (combineJobText, MAX_JOB_INPUT_CHARS).
Handoff to tailoring: set draft-console jobInput to description text (skips scrape); posting must stay inside the sealed assess token. Prefer a small prop/query-param on the existing draft entry; if draft-console must be edited, ONE package owns that edit.

## Contracts
export type SerpMode='live'|'replay';
export type SerpResult<T> = {ok:true;data:T;cached:boolean;mode:SerpMode;credits:number} | {ok:false;reason:'budget'|'not-configured'|'failed'|'rate';message:string};
searchJobs(q, opts?:{userId:string;refresh?:boolean}): Promise<SerpResult<Posting[]>>
companyIntel(company, serpJobId, userId): Promise<SerpResult<EmployerIntel>>
companyNews(company, userId): Promise<SerpResult<EmployerIntel['headlines']>>
parseSalaryLpa(text, serpSalary?): Posting['salaryLpa']; dedupePostings(p): Posting[]; creditStatus(): Promise<{left,hourUsed,mode}>
planSearch({digest,roles,contact,budget}): Promise<Plan>; rankPostings(postings,{records,roles,contact},topK?): RankedPosting[]; marketSignal(postings, heldKeywords): MarketSignal
RadarStatus {runId,status,phase,step,totalSteps,message,gate:'queries'|'select'|'',events:RadarEvent[],state:RunState,creditsUsed,mode,error}
startRadar(userId); advanceRadar(userId,runId,expectStep); approveQueries(userId,runId,queries); selectPosting(userId,runId,key) -> RadarStatus & {jobText}; cancelRadar; getRadar(userId,runId?)

## Work packages (disjoint files). Order: WP1 -> WP2 & WP3 parallel -> WP4 -> WP5. UI packages A-E (see UI-PLAN.md) run alongside; A first.
WP1 SerpApi layer: lib/serp/{types,client,normalize,salary,budget,fixtures}.ts, fixtures/serpapi/*.json, lib/db/schema-radar.ts (serpCache + agentRuns), one-line re-export in lib/db/schema.ts, .env.example (SERPAPI_API_KEY, SERP_MODE), tests.
WP2 pure agents: lib/radar/{planner,ranker,market}.ts + tests.
WP3 orchestrator: lib/radar/{runs,events}.ts + tests.
WP4 routes: app/api/radar/route.ts, app/api/radar/handoff/route.ts.
WP5 UI: app/radar/{page,loading}.tsx, components/radar/{run-view,timeline,result-row,market-card}.tsx, nav link, handoff wiring; consumes only RadarStatus and fetch routes; buildable against canned RadarStatus (?demo=1).

## Tests (offline, repo style: tests/*.test.mts via tests/run.mts, tests/harness.mjs suite/test/testAsync/assert/report)
serp-salary, serp-normalize, serp-client (stubbed fetch: params gl=in/google_domain/hl, cache hit => 1 fetch, budget block => no fetch, missing key => replay, errors never contain api_key), radar-ranker (no model call), radar-market, radar-state (transitions, cancel no-op, wrong expectStep rejected). Gate: npm test, typecheck, lint.

## 3-minute demo
0:00 pitch "job search that shows sources, never invents facts"; 0:20 start Radar, edit a query at G1, show credit meter; 0:50 live timeline (serpapi:google_jobs chips, dedupe count, ranking with matched/missing keywords, ratings+news); 1:30 Market Signal (median LPA, skills you lack); 1:50 G2 pick posting -> Tailor -> fit, draft, critic score; 2:30 open apply link chip, mention replay mode; 2:50 close: 3 engines, ~6-8 credits, cached, guarded.
