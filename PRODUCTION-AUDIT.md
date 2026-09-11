# Resumer AI — production audit

Audited 2026-09-11 against `main` (HEAD moved from 25e6f2a to e912a94 during the audit, because another developer was committing steward and skills work). Read-only: nothing in the repository was changed apart from this file.

**How it was checked.** I read AGENTS.md, README, PLAN, STEWARD and specs/AUDIT.md, then every API route, every server action, the three profile writers, the sync, import, steward and AI-chain modules, and the schema. I ran `npx tsc --noEmit`, `npm run lint`, `npm test`, `npx tsc -p scripts/tsconfig.json` and `npm run build`. I fetched signed-out pages and `/api/health` from https://resumeraiapp.netlify.app with curl. I ran two small Node checks to confirm behaviour (the filename header and the filename slug). The Playwright MCP server did not connect, so I did no real-browser or 390 px rendering. The UX findings come from reading the markup.

---

## 1. Summary

The core resume engine is careful work: it rejects ungrounded claims, keeps a per-draft and per-day budget, benches failing providers, protects against SSRF, encrypts tokens, rate-limits auth, and scopes almost every query to the signed-in user. Types, lint, the 47 test suites (801 assertions) and the production build all pass.

The weak points are at the edges that grew fastest:

- **A security hole in the GitHub App install callback.** A user can claim someone else's installation and read their private repository.
- **The portfolio sync writes the contact block without review**, and can blank the name and email.
- **Some paths can run past Netlify's 30-second limit**, and a run killed that way leaves no record, so nothing alerts on it:
  - the import commit (one database round trip per record)
  - import extraction (no deadline)
  - job-link scraping (a 45-second timeout)
  - GitHub API calls (no timeout)
- **The freshness check before each draft was never moved to the GitHub App**, so it still uses the old OAuth token.
- **The Experience section has no editor.** Jobs cannot be added, edited or removed by hand, and imports can create duplicate jobs.
- **The three writers disagree about content hashes**, and the steward acts on sync proposals the user has not approved yet.
- **CI does not type-check tests or scripts.** That type-check currently fails with 25 errors.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 5 |
| Medium | 15 |
| Low | 12 |

---

## 2. Findings

Effort: **S** is under half a day, **M** is one to two days, **L** is more than that.

### HIGH

#### H1. The GitHub App install callback lets anyone claim any installation
- **Category:** Security (authorization, cross-tenant)
- **Where:** `app/api/github/install/route.ts:43-64`, `lib/github/app.ts:181-212`, `lib/server/repo-access.ts:226-248` and `:152-164`
- **What is wrong:** The route takes `installation_id` from the query string. It then calls `getInstallation(id)` with the *app's* JWT. That call proves the installation exists. It does not prove the signed-in user installed it or has any access to it. The row is then written with `onConflictDoUpdate`, which **moves an existing installation to the caller's userId**. From then on:
  - `canConnectRepo` accepts any repository that installation covers (repo-access.ts:158-163).
  - The sync reads that private repository into the caller's profile.
  - The real owner silently loses the installation and falls back to OAuth.

  No `state` parameter is sent or checked either: `installUrl()` accepts one, and `app-install.tsx:30` calls it without one. The route's own comment claims this check stops exactly this attack. It does not. `schema.ts:103` calls installation ids "public-ish".
- **How verified:** I traced the flow in code from the redirect, to `getInstallation`, to `recordInstallation`, to `installationsFor`, to `canConnectRepo`, to `getRepoAccess`. No step compares the installation's account with the user's GitHub identity. Sign-up is open (email/password and Google), so any stranger can be "the caller".
- **Impact:** Someone who knows or guesses an installation id can read that account's private portfolio source and take its sync away from the owner. Installation ids are plain integers that show up in GitHub settings URLs, in redirect URLs and in logs.
- **Fix plan:**
  1. Bind the callback to the user's GitHub identity, using one of two options:
     - (a) Turn on "Request user authorization (OAuth) during installation". Exchange the returned `code` for a user-to-server token and call `GET /user/installations`. Accept the id only if it is in that list.
     - (b) Send a signed, single-use `state` (an HMAC of userId and a nonce, stored in `auth_token`) in `installUrl(state)` and require it in the callback. Also require that `installation.account.login` equals the user's linked GitHub login (`users.githubLogin`) or an org the user belongs to.
  2. In `recordInstallation`, refuse to reassign a row that belongs to a different userId. Change `onConflictDoUpdate` to update only when `userId` matches, and return an error otherwise.
  3. Add a test for the reassignment refusal and the state check (pure pieces into `tests/github-app.test.mts`).
- **Verify:** From a second test account, hit `/api/github/install?installation_id=<owner's id>`. It must redirect with `installError`, and the owner's row must be unchanged.
- **Needs owner:** GitHub App settings change (option a).
- **Effort:** M

#### H2. The portfolio sync overwrites the contact block without review, and can blank name and email
- **Category:** Data integrity / trust boundary
- **Where:** `lib/sync/stepped.ts:355-380`. Compare `lib/import/commit.ts:268-303` and `lib/sync/parse.ts:40-50`.
- **What is wrong:** The sync's final step upserts `contact_info` with `onConflictDoUpdate` using `fullName: parsed.contact.fullName ?? ''` and `email: ... ?? ''`. Every field in the extraction schema is optional, so any portfolio whose slices do not state a name or email writes `''` over the stored value. Phone, location and the LinkedIn/GitHub URLs become `null` the same way. This bypasses the review queue that `reconcile.ts` says is the "whole of the sync-injection defence". Contact details come from an LLM reading repository files, and they print at the top of every resume. The importer does the opposite and only fills gaps ("a resume PDF … should not be able to replace a current phone number").
- **How verified:** Read the code path. `parsed.contact` is `data.contact` from `toRecords` (parse.ts:635), which merges whatever the slices returned (parse.ts:396-400).
- **Impact:** One sync can wipe or change the name, email, phone and links on every future resume, silently. A prompt-injected repository can put an attacker's email or URL on the user's resumes.
- **Fix plan:**
  1. Replace the upsert with the importer's gap-filling merge. Extract `writeContact` from commit.ts into a shared helper and call it with source `github-sync`.
  2. Show any *changed* contact field to the user for approval on /profile, like other pending proposals. The minimum version is to never overwrite a non-empty field from a sync.
  3. Write an audit row for contact changes (the sync writes none today).
- **Verify:** Add a unit test: a stored contact plus a parsed contact with only `portfolioUrl` must keep the stored name, email and phone. Then run a sync on a test account with a portfolio that has no name.
- **Effort:** S

#### H3. The pre-draft freshness check still uses the old OAuth token, not the GitHub App
- **Category:** Half-built migration / correctness
- **Where:** `lib/server/profile.ts:135-158` (`getGithubToken` at line 143). Every other GitHub path uses `getRepoAccess` (`lib/sync/stepped.ts:221`, `app/api/cron/sync/route.ts:84`, `app/settings/portfolio/actions.ts:60`).
- **What is wrong:** `buildSyncStep` runs in front of every fit check and every draft without a fit token. It reads only the user's stored OAuth token. With the GitHub App configured (production: `/api/health` reports `githubApp: true`), sign-in asks only for `read:user user:email` (auth.ts:179-181). That token cannot read a private repository. Two things follow:
  - A private portfolio makes `latestCommitSha` fail with a 404. The stage prints "Couldn't refresh from GitHub (GitHub 404 on /repos/…: {…})" (run.ts:499-503) on every fit check, and new commits are never noticed.
  - A user who signed in with email or Google and installed the App gets "GitHub not connected — using your saved profile." even though the sync works for them.
- **How verified:** Read the code. Confirmed the scope choice in auth.ts and the live `githubOAuthScope` in `/api/health`. Production effect for the *owner* depends on whether their stored OAuth token predates the App and still carries `repo`. I could not see the database.
- **Impact:** The "never draft from a stale profile" promise (PLAN §0) fails for every App-only user. Every fit check spends two untimed GitHub calls (see M5) out of its 22-second budget to reach that result.
- **Fix plan:** In `buildSyncStep`, replace `getGithubToken` with `getRepoAccess(userId, { owner: ref.owner, name: ref.repo })` and use `access.token`. Trim the error to a sentence rather than the GitHub response body.
- **Verify:** Test account, email sign-in, App installed on a private repo, push a commit. The fit check must say "Your portfolio has new commits".
- **Effort:** S

#### H4. Committing an import makes one or two database round trips per record, and will pass 30 seconds
- **Category:** Production limits
- **Where:** `lib/import/commit.ts:133-216` (sequential per-role `select` and `insert`, then per-record `insert` and `audit`), `app/import/actions.ts:38-43`, `lib/server/steward.ts:532-542` (Add with AI uses the same path)
- **What is wrong:** Every record is its own `INSERT … ON CONFLICT DO NOTHING RETURNING`, followed by its own audit `INSERT`, one at a time. The codebase has already measured this:
  - `lib/server/profile.ts:203-205` says one statement per record took **34 s for 150 records**, which is why the sync was batched.
  - STEWARD §4 and `app/profile/profile-assistant.tsx:279-284` put a read, a write and an audit row at well over a second from Netlify to Neon.

  At about 0.25 s a round trip, a 60-record resume import makes about 120 statements, which is 30 s or more. A LinkedIn export with skills and one bullet per description line is larger. Nothing runs in a transaction (there is no `.transaction(` anywhere in `lib/` or `app/`).
- **How verified:** Read the code and used the project's own timing notes. The live timing is **suspected, not measured**. Confirm with a function log of a real import, or by timing `commitImport` on a 100-record payload against the production database from the same region.
- **Impact:** A large import dies at 30 s with some rows written and no summary. The user sees a server-action failure or a generic error. Re-running is mostly safe (records dedupe on the hash), but roles do not (see M8).
- **Fix plan:**
  1. Batch the writes the way `applyParsedProfile` does. Build all rows, then `insert(...).values(chunk).onConflictDoNothing().returning({id, contentHash})` in chunks of 100. Insert audit rows in one batch. Resolve roles with one `select` for all hashes, then one batched insert.
  2. Wrap each chunk in `db.transaction`.
  3. Lower the `CommitPayloadSchema` caps to what fits in one request (records ≤ 300), or commit in client-driven chunks.
  4. Note that server actions reject bodies over 1 MB by default (`node_modules/next/dist/docs/.../serverActions.md`), while the schema allows 2,000 records × 2,000 characters. Match the caps to the 1 MB limit.
- **Verify:** Time a 300-record commit locally against Neon. It should be well under 5 s.
- **Effort:** M

#### H5. Jobs (roles) cannot be added, edited or deleted by hand
- **Category:** Half-built feature
- **Where:**
  - The only writes to `role` are `lib/import/commit.ts:159`, `lib/server/profile.ts:401` and `lib/server/sync-review.ts:105` (review state only).
  - `app/profile/page.tsx:397-413` renders roles read-only.
  - `app/page.tsx:32-33` tells new users they can "add it by hand".
  - specs/AUDIT.md #4 wanted empty start dates rejected at write time, but `commit.ts:38` still defaults `startDate` to `''`.
- **What is wrong:** There is no action, form or route to create, rename, re-date or delete a role. A user who types their profile cannot add a job except through "Add with AI". A wrong company spelling, an empty start date (shown as "(no start)") or a duplicate job from an import (M8) can never be fixed or removed. The steward never proposes a role fix other than "ask". STEWARD.md's "reversed date ranges" rule does not exist in `lib/steward/rules.ts`.
- **How verified:** Searched for every `insert(rolesTable)`, `update(rolesTable)` and `delete(rolesTable)`, and for any role editor component. There are none beyond those listed.
- **Impact:** The Experience section is the most important part of a resume, and it is the one section the user cannot correct. Bad dates break the ATS date maths (AUDIT #4).
- **Fix plan:**
  1. Add a `role` form to `lib/profile/forms.ts` (title, company, location, start, end), plus `createRole`, `updateRole` and `deleteRole` in `lib/profile/records.ts`. Hash with `['role', company, title, startDate]` and check duplicates with `roleIdentity`.
  2. Deleting a role must either delete its bullets or move them to another role. Bullets reference the role only through `data.roleId`, with no foreign key, so a plain delete orphans them.
  3. Add an editor on /profile beside each role.
  4. Reject an empty `startDate` at every writer.
- **Verify:** Add a job, edit its dates, then delete it with bullets and check that nothing is orphaned (`scripts/verify-crud.mts` pattern).
- **Effort:** M

### MEDIUM

#### M1. The draft time budget depends on an environment variable nobody can see
- **Category:** Production limits / config
- **Where:** `lib/ai/budget.ts:53-69`, `app/api/health/route.ts:38-47`
- **What is wrong:** Without `MAX_DRAFT_SECONDS`, the draft budget is 280 s. The Netlify branch (`if (process.env.NETLIFY) return 20_000`) never runs, because live `/api/health` reports `platform.netlify: false`. The code comment admits it. So production survives only while `MAX_DRAFT_SECONDS` stays set in the Netlify UI, and `/api/health` does not report it. The same default feeds `new DraftBudget()` in `app/api/resume/[snapshotId]/extras/route.ts:69`. `AI_ATTEMPT_TIMEOUT_MS` (default 25 s, `lib/ai/chain.ts:86`) has the same problem.
- **How verified:** Code, plus the live health output.
- **Impact:** One lost variable, for example in a new site, a branch deploy or an environment cleanup, puts every draft back to being killed at 30 s with nothing recorded (see M4). That was the original production outage described in schema.ts:421-431.
- **Fix plan:** Default to 20 s unless `VERCEL` is set, since a safe default is cheap. Add `draftSeconds`, `assessSeconds` and `attemptTimeoutMs` to `/api/health`. Lower the chain's default attempt timeout to 10 s.
- **Verify:** `/api/health` shows the effective numbers. A unit test covers `defaultTimeBudgetMs` with no variables set.
- **Effort:** S

#### M2. Job-link scraping allows 45 seconds inside a 22-second fit check
- **Category:** Production limits
- **Where:** `lib/intake/scrape.ts:70` (`AbortSignal.timeout(45_000)`), called from `lib/pipeline/run.ts:519-520` inside `runAssessment` (budget 22 s, run.ts:193-196)
- **What is wrong:** The Firecrawl call is not bounded by the budget. A slow JavaScript-rendered careers page takes the function past 30 s.
- **Impact:** Pasting a link is a main input path. On a slow page the fit check dies with "connection closed", and no run is recorded (M4).
- **Fix plan:** Pass the budget into `readJob` and `scrapeJobUrl`. Use `AbortSignal.timeout(min(12_000, budget.remainingMs - 8_000))`. When it times out, return the existing "paste the text instead" outcome.
- **Verify:** A unit test with a stubbed slow fetch. Manually, try a known slow page.
- **Effort:** S

#### M3. Import extraction has no deadline, so one chunk can outlive the function
- **Category:** Production limits
- **Where:** `lib/import/parse.ts:161-170` (`options: { budget, temperature }`, no `deadlineMs`), `lib/ai/chain.ts:257-260` and `:376-378` (no deadline means `Infinity`), `app/api/import/parse/route.ts:52-58`
- **What is wrong:** Every other model call goes through `draftCallOptions` or passes a deadline. This one gets up to 25 s per attempt × 5 providers × 2 paths, with one retry inside each provider. When Netlify kills it, the browser's `await res.json()` fails on the HTML 502 page. `importer.tsx:184` and `:232-234` then show the raw `SyntaxError` text and throw away every chunk already parsed.
- **How verified:** Code. I compared every `generateStructured` call site: the others pass `draftCallOptions`, a deadline, or a timeout.
- **Fix plan:** In the route, `new DraftBudget({maxCalls: 6, maxTokens: 60_000}, 20_000, 1_000)`, and in `extractFromChunk`, `options: draftCallOptions(budget, { temperature: 0.1 })`. In the importer, check `res.ok` and the content-type before `json()`, keep the partials, and let the user retry the failed chunk.
- **Effort:** S

#### M4. A function killed at the time limit leaves no run record, so the alerts miss it
- **Category:** Observability
- **Where:** `lib/server/sse.ts:81-107` (the `finish` step runs only if the function survives), `lib/server/draft-run.ts:127-132` (status is only `success` or `failed`), `lib/server/draft-alerts.ts:91-97`
- **What is wrong:** `draft_run` rows are written at the end. A 30-second kill, which is the most likely production failure (M1, M2, M3, M5), never reaches `finish`. So the Activity page and the hourly alert cannot see it. The schema comment says this table exists because failed drafts "persisted nothing". That is still true for this kind of failure.
- **Fix plan:** Insert the row with `status: 'running'` when the stream starts, and update it in `finish`. In `runDraftAlerts`, also count rows still `running` with `startedAt` older than two minutes, as `errorKind: 'killed'`. The same approach works for sync jobs stuck at `running`.
- **Verify:** A unit test on `composeAlert` with a stale running row. Manually, set `MAX_DRAFT_SECONDS=60` on a preview deploy and check that the killed run shows up.
- **Effort:** S–M

#### M5. GitHub API calls have no timeout
- **Category:** Production limits
- **Where:** `lib/sync/github.ts:61-74` (`gh()`, used for SHA, tree and blobs), `lib/server/repo-access.ts:179-186`
- **What is wrong:** Every other outside call (`installationToken`, mail, OAuth refresh, Firecrawl, safe-fetch) has an `AbortSignal.timeout`. These two do not. They run in front of every fit check (`buildSyncStep`), in sync step 0 (budget 8.5 s), in the cron job and in connect-repo.
- **Fix plan:** Add `signal: AbortSignal.timeout(8_000)` to `gh()` and to the permissions fetch. Cut the thrown message down to status plus path, and log the body instead of throwing it (see L1).
- **Effort:** S

#### M6. The three writers hash the same fact in different ways
- **Category:** Data integrity (duplicates)
- **Where:**
  - Experience bullets: manual writes `['experience-bullet', roleId, text]` (`lib/profile/records.ts:175`, `:189`, `:443`). Sync, resume import and LinkedIn write `['bullet', company, text]` (`lib/sync/parse.ts:480`, `lib/import/commit.ts:175`, `lib/import/linkedin.ts:270`). `lib/profile/forms.ts:38-43` requires the recipes to match.
  - Tidying: `applyParsedProfile` stores *tidied* data under the parser's hash of the *raw* data (`lib/server/profile.ts:237-240`, the comment says this is deliberate). Manual and import writers hash *after* tidying (`records.ts:337-338`, `commit.ts:85`).
- **What is wrong:**
  - The same bullet typed by hand and synced or imported keeps both copies, because the unique index cannot see them as the same.
  - Any steward `fix` on an imported or synced bullet re-hashes it with the manual recipe even when the text is unchanged.
  - Wherever tidying changes an identity field (the canonical skill spelling "ReactJS" becomes "React", look-alike hyphens), a synced record and a manual one never collide.
  - The steward's duplicate checks (`lib/server/steward.ts:437`, `:506`, `:600`) compare against stored hashes and miss synced rows for the same reason.
- **How verified:** Compared every `hashContent(` call site (grep list in this audit).
- **Fix plan:** Pick one bullet recipe. `['bullet', company, text]` is safer because it does not depend on the row id. Use it in `records.ts`, and add a one-off script (read-only first, like `scripts/dedupe-audit.mts`) that reports and then re-hashes existing manual bullets. For sync, hash the tidied data and match the old hash in `reconcile` too for one release. Put the recipe in one exported function per type and have every writer call it.
- **Verify:** A test that imports the same bullet through all three writers and expects exactly one row.
- **Effort:** M

#### M7. One conflicting update fails the sync mid-write, every time
- **Category:** Data integrity / error handling
- **Where:** `lib/server/profile.ts:250-283` (updates change `contentHash` with no unique-violation handling), `:312-314` (audit rows written last), `lib/sync/stepped.ts:178-183`
- **What is wrong:** An identity-matched update can set a `contentHash` that already belongs to another row of the same user, for example a manual record the sync cannot see (reconcile never reads manual rows). A plausible case: the parser starts filing "Machine Learning" as `method` while the user has a manual `method` copy. `Promise.all` rejects with a Postgres 23505. By then the inserts are done but the audit rows and `lastSyncedSha` are not. The job is marked `error` and the raw SQL text is shown to the user. The next sync makes the same update and fails the same way, so the sync breaks for good. None of this is in a transaction.
- **How verified:** Code. The trigger in practice is **suspected**. Confirm by checking `sync_job` rows with `status='error'` and an `error` beginning "Failed query: update".
- **Fix plan:** Before updating, drop any update whose new hash is already taken (compare against an `existing` hash set that includes manual rows), and count it as unchanged. Or catch 23505 per row. Wrap the write phase in `db.transaction` so audits and SHA commit together with the rows.
- **Effort:** S–M

#### M8. Imports match existing jobs by exact hash, so jobs duplicate
- **Category:** Data integrity
- **Where:** `lib/import/commit.ts:146-172`. Compare `lib/server/profile.ts:365-397` (sync uses `roleIdentity` and `splitMergedTitles`). `lib/db/schema.ts:191-212` has no unique index on roles.
- **What is wrong:** Resume import, LinkedIn import and Add with AI match an existing job only when company, title and start date hash exactly the same. "2022-01" and "2022", "Acme Inc." and "Acme", or an empty start date all create a second row. This is the bug in specs/AUDIT.md #1 ("16 rows for 9 jobs"), fixed for the sync and brought back through the import. Two concurrent commits can also both miss the `select` and insert the same job twice. Because of H5, the user cannot delete the extra copy.
- **Fix plan:** Reuse `roleIdentity` in `commitImport`: load the user's jobs once and match on identity before hash. Add a unique index on `(user_id, content_hash)` for `role` after cleaning up existing duplicates.
- **Effort:** S

#### M9. The steward acts on sync proposals the user has not approved, and one action approves them
- **Category:** Data integrity / trust boundary
- **Where:** `lib/server/steward.ts:55-65` (profile loaded with `ne(reviewState,'rejected')`, so pending rows are included), `:318-335` (`move` → `createTypedRecord`, which gets the schema default `review_state='approved'`, schema.ts:248), `:312-316` (`merge` and `remove` → `deleteRecord`, a hard delete)
- **What is wrong:**
  - A **move** suggestion on a pending synced record makes a new *approved* manual record. That skips the review step that `reconcile.ts` calls the whole defence against sync injection.
  - A **merge** or **remove** of a pending record deletes it outright instead of leaving a `rejected` marker (the "tombstone" that tells the sync the user already said no). The next sync proposes it again.
  - A **fix** changes the record's source to `manual` while leaving it pending. The next sync then proposes the original wording again as a new item.
  - STEWARD §3.4 says pending items get their own "Review with AI" in the sync queue. That was never built, but the general review covers them anyway.
- **Fix plan:** Load only `approved` rows in `loadStewardProfile`. Or, if pending rows should stay reviewable, keep their `reviewState` on move and mark them `rejected` instead of deleting them on merge or remove.
- **Effort:** S

#### M10. Downloading a resume fails (500) for any name or company outside Latin-1
- **Category:** Correctness
- **Where:** `lib/render/filename.ts:8-17` (keeps `\p{L}`, which includes Tamil, Devanagari and CJK letters), `app/api/export/[snapshotId]/route.ts:59-69` (`filename="${fileName}"`)
- **What is wrong:** HTTP header values must be ByteStrings. I confirmed with Node: `new Response('x',{headers:{'Content-Disposition':'attachment; filename="北京.pdf"'}})` throws "Cannot convert argument to a ByteString". `resumeFileName` returns `Jose_Muller_北京_Tech.pdf` for company "北京 Tech", so the export route throws.
- **Impact:** No PDF or DOCX download for users or target companies whose names are in a non-Latin script. That matters for a product aimed at India.
- **Fix plan:** Send `filename="<ASCII fallback>"; filename*=UTF-8''<encodeURIComponent(name)>`, with the ASCII fallback made by stripping non-ASCII. Add a test in `tests/render.test.mts`.
- **Effort:** S

#### M11. A resume that was already sent can still be edited in place
- **Category:** Correctness (REQ-9.2)
- **Where:** `app/api/resume/[snapshotId]/route.ts:117-165`. Compare the improve route (`app/api/draft/[snapshotId]/improve/route.ts:47-52`).
- **What is wrong:** The improve route refuses once the application has left `draft`, because the snapshot is then "exactly what was sent". PATCH has no such check, so hand edits overwrite the record of what the recruiter received.
- **Fix plan:** Load the application status (reuse `loadSnapshotForImprove`'s query) and return 409 unless it is `draft`. Or save edits as a new snapshot. Make the editor read-only in the UI for sent applications.
- **Effort:** S

#### M12. TOKEN_ENC_KEY is documented as optional, but without it no draft can run
- **Category:** Config / docs drift
- **Where:** `lib/fit/token.ts` (`sealAssessment` → `encryptSecret`), `lib/auth/secret-box.ts:45-46` (throws `MissingKeyError`), `.env.example` ("Without it the app still runs and warns"), README setup table (not listed), `app/page.tsx:11` (the readiness check ignores it)
- **What is wrong:** Every draft now starts with a fit check, and the fit check seals its result with `encryptSecret`. Without the key, every fit check ends in "The fit check failed unexpectedly". Production has the key (health reports `tokenEncryption: true`), so this breaks new deploys, local setups and forks.
- **Fix plan:** List `TOKEN_ENC_KEY` as required in README and `.env.example`. Add it to `SetupChecklist` and to the `ready` condition in `app/page.tsx`. Alternatively, sign the fit token with an HMAC derived from `AUTH_SECRET` when no key is set.
- **Effort:** S

#### M13. CI does not type-check tests or scripts, and that type-check fails
- **Category:** Tests / tooling
- **Where:** `.github/workflows/ci.yml` (`npx tsc --noEmit` only), `package.json` `typecheck` script, `tests/harness.mts:20-33`
- **What is wrong:**
  - `npx tsc --noEmit -p scripts/tsconfig.json` fails with 25 errors:
    - test fixtures missing `reviewState` (gate-loop.test.mts:55-63)
    - `.text` and `.name` used on the wrong record types (enrichment.test.mts:189-404, fit.test.mts:198)
    - a missing module in `scripts/dedupe-certifications.mts:27` and `scripts/dedupe-education.mts:22`
    - `tests/auth.test.mts:307`, `tests/sections.test.mts:739`
  - `test()` is synchronous but is given `async` bodies (auth.test.mts:29-60, flags.test.mts:129 and :166, sections.test.mts:708). "ok" prints before the assertions run. A failure only surfaces as an "unhandled rejection" under the wrong suite name, so the per-test output cannot be trusted.
  - There are no tests at all for `commitImport`, `applyParsedProfile`, `applySuggestion`, `advanceSyncJob`, the install route or the webhook. Authorization checks live only in `scripts/verify-authz.mts`, which needs a database and is not in CI.
- **Fix plan:** Add `npm run typecheck` to CI and fix the 25 errors. Make `test()` reject async bodies at runtime, or convert them to `testAsync`. Move the hash, merge and conflict logic of the writers into pure functions with tests. Add a CI job with a throwaway Postgres (`services: postgres`) running `db:push` and the `verify-*` scripts.
- **Effort:** M

#### M14. No app-wide AI spending cap, and anyone can sign up
- **Category:** Security / cost
- **Where:** `lib/ai/daily-budget.ts:48-63` (per user only), `lib/ai/budget.ts:101-104`, `app/sign-in/account-actions.ts:66` (open sign-up), Google sign-in open
- **What is wrong:** The ceiling is 400 calls a day *per user*. The sign-up rate limit is 10 an hour per IP, and Google accounts are free, so a handful of accounts can use up the shared provider quotas or bill the owner. The steward review, Add with AI, fit checks, imports and cover letters all spend from shared keys.
- **Fix plan:** Add a global daily row (for example `user_id='*'`) checked in `assertDailyBudget`. Add an invite or allow-list, or require email verification before any AI call. Alert when global use passes 80%.
- **Needs owner:** the cap figures and whether sign-up stays open.
- **Effort:** S

#### M15. No way for a user to delete their account or data
- **Category:** Security / privacy
- **Where:** no code path deletes a `user` row (searched `delete(users)` and "delete account"). The app stores contact PII, EEO answers, salary expectations (`app/settings/application`), resumes and audit logs.
- **Impact:** Anyone can sign up, so privacy law (India's DPDP Act, GDPR) and basic trust call for self-service deletion. Every table already cascades on `user.id`, so the delete itself is one statement.
- **Fix plan:** A "Delete my account" server action on /settings: re-check the password or confirm by email, delete the `user` row (the cascades do the rest), then sign out. Also offer a JSON export.
- **Needs owner:** retention policy.
- **Effort:** S

### LOW

#### L1. Internal error text reaches users on several paths
- **Category:** Error handling
- **Where:**
  - `app/api/import/parse/route.ts:66` (provider error as `reason`)
  - `app/import/actions.ts:50` and `app/settings/application/actions.ts:61` (Drizzle "Failed query: …" text)
  - `app/api/resume/[snapshotId]/extras/route.ts:84-86`
  - `app/api/sync/route.ts:29-32` and `lib/sync/stepped.ts:179-191` (GitHub response bodies thrown by `lib/sync/github.ts:71`)
  - `lib/pipeline/run.ts:502` (`short(err)` streamed)
  - `app/activity/page.tsx:99` (shows `errorDetail`, which the schema says is for the owner only, to every user about their own runs)
- **What is wrong:** The draft route explains at length why this must not happen. These paths ignore that rule. No secrets were seen (redaction exists for `errorDetail`).
- **Fix:** One `userMessage(err)` helper that turns known error classes into sentences and logs the rest. Show `errorDetail` only when `ALERT_EMAIL` matches the user's email.
- **Effort:** S

#### L2. Housekeeping code is never called, and failed sync jobs keep their payload
- **Category:** Production limits / storage
- **Where:**
  - `purgeOldAttempts` (`lib/auth/rate-limit.ts:189`) and `purgeExpiredTokens` (`lib/auth/tokens.ts:100`) have no callers.
  - `sync_job` rows are never deleted, and the error path (`stepped.ts:180-183`) keeps `corpus`, up to 40 × 120 KB of repository text, and `partials`.
  - `audit_log` and `steward_dismissal` grow without limit.
- **Fix:** Call the purges and a `sync_job` cleanup (delete finished jobs older than 7 days, null out `corpus` on error) from the existing hourly `/api/cron/alerts`.
- **Effort:** S

#### L3. /api/health tells anonymous visitors more than they need
- **Category:** Security
- **Where:** `app/api/health/route.ts:23-33`, `:62-74`
- **What is wrong:** Unauthenticated, it returns the character *length* of AUTH_SECRET, AUTH_GITHUB_SECRET and DATABASE_URL, whether cron is enabled, the provider list and the OAuth scope.
- **Fix:** Return only `ok` to the public. Show details when the request carries `CRON_SECRET` or comes from the owner's session.
- **Effort:** S

#### L4. No error or not-found pages, and a failed import step shows a raw parse error
- **Category:** UX
- **Where:** no `app/error.tsx`, `app/global-error.tsx` or `app/not-found.tsx` (live 404 is Next's default page). `app/import/importer.tsx:184-186` and `:232-234` show `SyntaxError` text when a step returns the HTML 502 page. `app/settings/portfolio/portfolio-form.tsx:54-64` uses the same `res.json()` pattern.
- **Fix:** Add a styled `error.tsx` with a retry button, and check `res.ok` and the content type before parsing JSON.
- **Effort:** S

#### L5. setApplicationStatus: dates overwritten and status unchecked
- **Category:** Correctness
- **Where:** `app/applications/actions.ts:16-33`
- **What is wrong:** `appliedAt` is reset to now on *every* status change, although the comment says it is "stamped the first time it leaves draft". `status` is a TypeScript type only; any string is stored. Setting a sent application back to `draft` unlocks improve and edit on its snapshot (see M11).
- **Fix:** Validate against the enum. Set `appliedAt` only when it is null. Refuse going back to `draft` once a snapshot has been sent, or snapshot before allowing it.
- **Effort:** S

#### L6. The content hash joins its parts with no separator
- **Category:** Data integrity
- **Where:** `lib/sync/reconcile.ts:67-72` (`parts.filter(Boolean).join('')`)
- **What is wrong:** Different field values can collide across part boundaries, and empty parts shift the boundaries. With the unique index plus `onConflictDoNothing`, a collision silently drops a record. The chance is low, so this is a latent problem rather than a live one.
- **Fix:** Join with a separator such as `'␟'`, done as a versioned migration together with M6.
- **Effort:** S (plus a re-hash migration)

#### L7. The importer stores mismatched bullet text and trusts browser-supplied tags
- **Category:** Data consistency / trust boundary
- **Where:** `app/import/importer.tsx:270-283` (taking a steward rewrite changes `text` but not `action`), `:818-824`, `lib/import/commit.ts:179` and `:209` (tags stored as the browser sent them)
- **What is wrong:** A bullet can be stored with `text` ≠ `action`. The evidence grader and reconcile's identity key read `action`. Every other writer derives tags on the server with `deriveTags`. Only this one trusts the client, and tags feed `profileVocabulary`, which decides which job keywords a resume may claim (`lib/quality/skills.ts:38-52`).
- **Fix:** Derive tags on the server in `commitImport`. When the rewrite changes `text` and there is no scale or outcome, set `action = text`.
- **Effort:** S

#### L8. The cron job always checks the same users and stops on one error; the webhook is case-sensitive
- **Category:** Robustness
- **Where:** `app/api/cron/sync/route.ts:56-64` (`limit 25`, no order), `:84` (`getRepoAccess` outside the try), `app/api/webhook/github/route.ts:98-102` (`eq(users.portfolioRepo, repo)`)
- **What is wrong:** With no ordering and a cap of 25, the same users are checked every day and the rest never are. One throwing `getRepoAccess` aborts the whole run. The webhook compares repository names case-sensitively, so a user who typed `Owner/Repo` never has their cache cleared.
- **Fix:** Order by `lastSyncedAt` with nulls first. Move the access lookup inside the try. Compare with `lower()`.
- **Effort:** S

#### L9. README, PLAN and config comments no longer match the app
- **Category:** Docs drift
- **Where and what:**
  - README says "Use Vercel, not Netlify" and "Netlify would time out", but the app runs on Netlify.
  - README says "95 assertions"; there are 801.
  - README and `.env.example` give the provider order as Gemini first. Live `/api/health` shows Fireworks, Groq, Together, DeepInfra, Gemini (see `lib/ai/models.ts:13-52`).
  - README's env table leaves out TOKEN_ENC_KEY, the Google, SMTP and GitHub App variables, CRON_SECRET, ALERT_EMAIL and MAX_DRAFT_SECONDS.
  - README describes one Netlify function; there are two.
  - README says a changed SHA means "re-parse and reconcile" before a draft. It now only warns.
  - `netlify.toml` header says the app "sets a 50s internal deadline when NETLIFY is present". It is 20 s, and NETLIFY is never present at runtime.
  - `maxDuration = 300/120/60` exports look meaningful but do nothing on Netlify.
  - `.env.example` does not document variables the code reads: `AI_PROVIDER_ORDER`, `AI_PROVIDER_COOLDOWN_MS`, `AI_SLOW_COOLDOWN_MS`, `AI_COOLDOWN_CACHE_MS`, `SYNC_STEP_BUDGET_MS`, `SYNC_SLICE_CHARS`, `SYNC_ATTEMPT_TIMEOUT_MS`, `MAX_ASSESS_SECONDS`, `CRON_MAX_USERS`, `CRON_BUDGET_MS`, `RESEND_API_KEY`.
  - PLAN.md still describes Clerk, pgvector embeddings, Vercel Blob and an OpenResume/Affinda tier, none of which exist (embeddings were deleted per AUDIT #12).
- **Fix:** One docs pass. Mark PLAN.md as the historical plan and point to the specs.
- **Effort:** S

#### L10. STEWARD.md promises differ from the code; the server accepts 60 quick fixes a request
- **Category:** Docs drift / limits
- **What is wrong:**
  - STEWARD §4 says quick fixes "apply five per request". The client sends 12 (`app/profile/profile-assistant.tsx:284`), and the server accepts up to 60 (`app/profile/steward-actions.ts:92`), which is past the measured 30-second ceiling.
  - §3 lists a "reversed date ranges" rule that is not in `lib/steward/rules.ts`.
  - §3.4 "Review with AI" on the sync queue is not built.
- **Fix:** Cap the server at 12. Update STEWARD.md or build the missing pieces.
- **Effort:** S

#### L11. Every page declares the home page as its canonical URL
- **Category:** UX / SEO
- **Where:** `app/layout.tsx:32` (`alternates: { canonical: '/' }` in the root metadata)
- **What is wrong:** Every page, including `/sign-in` (which is in the sitemap), declares the home page as canonical. Checked on the live site.
- **Fix:** Set canonical per page, or drop it from the layout.
- **Effort:** S

#### L12. Two queries skip the user scope
- **Category:** Security (defence in depth)
- **Where:** `lib/server/steward.ts:295` (reads `profileRecords` by `s.recordId` with no `userId` filter; `assertFresh` checks only the ids listed in `basis`, not `recordId`), `lib/server/profile.ts:264-280` (sync updates filter by id without `userId`)
- **What is wrong:** Neither is exploitable today: the first only reads one boolean, and the second takes ids from the user's own rows. Both break the NFR-6 rule of scoping every query to the user.
- **Fix:** Add `eq(userId)` to both. In `assertFresh`, require `s.recordId ∈ basis`.
- **Effort:** S

---

## 3. Prioritised fix plan

**Phase 0 — security and data-loss holes (about 2 days)**
1. H1: install-callback identity binding and no reassigning of installations.
2. H2: stop the sync overwriting contact details.
3. M9: steward limited to approved records.
4. L12: add the missing user scope.
5. M11 and L5: protect snapshots that have been sent.

**Phase 1 — stay inside 30 seconds, and see it when we don't (about 2–3 days)**
1. M1: safe default budget, reported in `/api/health`.
2. M4: record runs as `running` at start and alert on stale ones.
3. H4: batched, transactional import commit.
4. M3: deadline for import extraction.
5. M2: scrape bounded by the budget.
6. M5: GitHub timeouts.
7. H3: freshness check through `getRepoAccess`.
8. Then check the Activity page and the alert over one week.

**Phase 2 — profile data integrity (about 3–4 days)**
1. H5: job editor and deletion.
2. M8: identity matching for jobs in imports, plus a unique index after cleanup.
3. M6 and L6: one hash recipe per type, with a read-only duplicate report, then re-hash.
4. M7: conflict-safe, transactional sync writes.
5. L7: server-derived tags, consistent `action`.

**Phase 3 — tooling and polish (about 2 days)**
1. M13: typecheck in CI, harness fix, writer tests, Postgres CI job.
2. M10: filename header.
3. M12: TOKEN_ENC_KEY.
4. L1 and L4: user-facing errors, `error.tsx`.
5. L2: housekeeping in the hourly cron.
6. L8, L10, L11.

**Phase 4 — policy (after owner decisions)**
1. M14: global AI cap and sign-up policy.
2. M15: account deletion and export.
3. L3: health lock-down.
4. L9: docs pass.

**Needs the owner's input**
- GitHub App settings: turn on "Request user authorization during installation" (H1, option a), and decide whether the App stays "Only on this account".
- Confirm that `MAX_DRAFT_SECONDS`, `MAX_ASSESS_SECONDS` and `AI_ATTEMPT_TIMEOUT_MS` are set in Netlify, since `/api/health` cannot show them yet (M1).
- The global daily AI cap and whether sign-up stays open (M14).
- Data-retention and deletion policy (M15).
- Whether the portfolio may ever update contact details, or only fill gaps (H2).
- Whether to move from `db:push` to committed migrations (`drizzle-kit generate`). Without migration history there is no way to prove the production schema matches `lib/db/schema.ts`. That includes the new `steward_dismissal` and `skill_category` tables and the `method` category. I could not check the live database, so this remains **unverified**.
- Sentry DSN (open item in memory).
- Neon region compared with the Netlify function region. It drives the per-round-trip cost behind H4 and L10.

---

## 4. What I checked and found fine

- **Authorization:**
  - Every API route and server action calls `auth()` and scopes by `userId`: records, roles, snapshots, applications, enrichment, sync review, steward apply, sync jobs.
  - Cron routes require `CRON_SECRET` with a constant-time compare. Live: 401 signed out.
  - The GitHub webhook checks its HMAC in constant time.
  - Dev routes return 404 in production (live: `/api/dev/selftest` 404, `/api/dev/e2e-draft` POST 404).
- **Auth:**
  - Passwords are scrypt-hashed, with a dummy hash so unknown and OAuth-only addresses take the same time.
  - Rate limits sit in the Credentials `authorize` path itself.
  - Sessions are revoked on password reset through `sessionsValidFrom`.
  - Email linking is limited to verified addresses (Google `email_verified` is checked).
  - Provider tokens are encrypted when stored.
- **Headers and hosting:** CSP, `frame-ancestors 'none'`, HSTS and `nosniff` are all live, and `no-referrer` is set on the reset and verify pages. The robots rules keep private pages out.
- **Fetching outside URLs and files:**
  - `safe-fetch` blocks private address ranges and re-checks every redirect (it has a documented DNS-rebinding limit).
  - Uploads have size caps, ZIP bomb limits and a type check that does not trust the browser.
- **XSS:** `dangerouslySetInnerHTML` appears only for static JSON-LD and a fixed script.
- **Grounding and budgets:**
  - Fit tokens are encrypted, tied to the user and expire.
  - The per-draft and daily budgets count failed attempts too.
  - Draft, fit and improve streams write a run record on every path that finishes.
- **Build health:**
  - `npx tsc --noEmit` passes.
  - `npm run lint` is clean.
  - `npm test` passes: 47 suites, 801 assertions.
  - `npm run build` succeeds with no warnings in its output.
- **UX:**
  - Every signed-in page uses the same `max-w-6xl px-5 py-8` container.
  - The global `:focus-visible` ring is unlayered CSS, so it beats Tailwind's layered `outline-none` and focus stays visible.
  - Targets use `min-h-11` (44 px).
  - Sign-in inputs sit inside their `<label>`s.
  - The colour palette was checked against WCAG AA in `globals.css`.
  - Stream-closed and timeout states in the draft console have readable messages.
- **Not covered:** real-browser and 390 px rendering (Playwright was unavailable), live database schema and contents, and function logs.
