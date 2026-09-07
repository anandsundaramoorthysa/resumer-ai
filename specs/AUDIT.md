# Resumer AI — defect audit

Findings from auditing the real synced profile (174 records, 16 roles) plus research
into what resumes and ATS parsers actually require. Every data defect below was observed
in the live database, not inferred.

Severity: **S1** breaks the output · **S2** materially degrades it · **S3** polish.

---

## S1 — Breaks the output

### 1. Duplicate roles — 16 rows for roughly 9 real jobs
Observed:
```
Corizo | Flutter Developer (Paid Intern) | 2024-04 -> 2024-06
Corizo | Flutter Developer Intern       | 2024-04 -> 2024-06
D2R AI Labs  | Product & Automation Engineering Intern | 2026-04 -> 2026-05
D2RAI Labs   | Product & Automation Engineering Intern | 2026-04 -> 2026-05
DiffuseAi / DiffuseAI          (case variants, 4 rows)
Medium / Medium (Self-Published)
Sparks AI / Sparks AI / Welbuilt AI Solutions Pvt. Ltd.
```
**Cause.** Roles are not `ProfileRecord`s, so they never pass through `reconcile()` and its
`identityKey` normalisation. `applyParsedProfile` inserts them with
`onConflictDoNothing()` keyed on `contentHash`, and a company written two ways hashes
two ways. This is the same defect just fixed for education, in the one place the fix
does not reach.

**Fix.** Give roles the same normalised identity as education: company reduced to its
leading words with punctuation and suffixes ("Pvt. Ltd.", "(Autonomous)") stripped, title
normalised, and dates used as a tiebreak. Merge on match rather than insert. Needs a real
unique constraint too — `onConflictDoNothing` with no matching constraint silently does
nothing, which is why duplicates accumulated on every sync.

### 2. Fourteen of sixteen roles have no bullets
Only 2 roles carry any experience bullets; 6 bullets total. This is why the generated
resume had **no Experience section at all**, and why the evidence sub-score was 0%.

**Cause.** `src/data/experienceData.ts` holds titles, companies and dates only. The prose
describing what was actually done lives elsewhere in the portfolio (page components), and
those files either are not matched by `CONTENT_PATTERNS` or are matched but not mined for
per-role bullets.

**Fix.** Widen the file patterns to reach the experience page components, and make the
extractor attach loose accomplishment prose to the nearest named role rather than
discarding it. Where a role genuinely has no described work, say so in the UI — an empty
Experience section should be visible as a gap to fill, not silently absent.

### 3. One row merges three separate roles
`DiffuseAI | Artificial Intelligence Intern / Full Stack Developer / Project Manager`
exists as one row *and* as three correct separate rows.

**Fix.** Split titles containing " / " into separate roles at extraction, then let the
identity merge collapse them against the correctly-split ones.

---

## S2 — Materially degrades the resume

### 4. Roles with no start date
`DiffuseAI` and `Freelancer` have empty `startDate`, which renders as "– Present" and
sorts unpredictably. Research is explicit that inconsistent or partial dates make ATS
date-maths fail and can invent employment gaps.

**Fix.** Treat a missing start date as a validation error at write time, inferring from
sibling roles where possible; never render a half date range.

### 5. Zero of 32 projects carry an impact metric
Average description 171 characters, no metrics anywhere. The evidence sub-score is 30% of
the total and is defined as action + scale + outcome, so it can never score well.

**Fix.** This is partly a data problem, not a code one — the portfolio genuinely does not
state outcomes. The honest response is to surface it: flag metric-less projects in the
profile UI as "no measurable outcome recorded", so the gap is visible and fixable at
source. The generator must keep refusing to invent numbers.

### 6. Education dates are wrong as well as duplicated
`Loyola College | 2027 -> (no end)` — a graduation year captured as a start date. No
education row has an end date.

**Fix.** Extraction needs explicit start/end semantics, and a sanity rule that a single
four-digit year on a degree is a graduation year unless a range is given.

### 7. Resume is far too short
The generated resume measured ~1,150 characters, roughly 180 words. Research targets
350–450 words for entry level. It reads as thin regardless of formatting score.

**Fix.** Consequence of #1, #2 and #5 — fixing those fills it. Add a word-count check to
the quality gate so "too sparse to be credible" is scored rather than silently accepted,
the same way the empty-resume case now is.

**Fixed.** `lib/quality/length.ts`. Both directions are measured against the page budget
`assemble.ts` already spends: `CONTENT_LINES_PER_PAGE` (29) gained a companion
`CONTENT_WORDS_PER_PAGE` (350), derived the same way — A4 less padding, 10.5pt on 1.4
leading, ~12 words to a content line — rather than a second, competing notion of length.
That the derivation lands on the 350–450 words research asks of a one-page entry-level
resume, without being aimed at it, is the reason to trust either figure.

The floor is 60% of one page, 210 words, and it does not double when the budget does: a
second page is permission, not an obligation. 210 sits between the two numbers that fix
it — the ~180-word resume this audit observed, and the 350-word target — so it fires on a
document that is missing content rather than on one that is merely concise. The ceiling is
the line budget exactly, plus 15% slack on the word figure, since a resume of unusually
full lines is dense rather than overlong.

It is scored beside the formatting rules rather than among them, priced as one rule of
eleven (~0.25/10 overall). `scoreFormatting` documents itself as testing mechanical
parsing failures, and a parser reads a 180-word resume perfectly well — length is a
judgement about substance. `scoreFormatting` is also what the self-test and the smoke
script call for a verdict on parseability, and it still answers only that question.

### 8. Bullets are capped globally, not distributed per role
`bulletAllowance` caps the total (11 or 20). Research says 3–5 per role, most recent role
weighted highest, older roles tapered to 2–3.

**Fix.** Distribute the allowance across roles by recency instead of taking a flat top-N.

**Fixed.** `distributeBulletsByRecency` in `lib/generate/assemble.ts`. Two passes: a floor
pass seats every role at 2 bullets before any role gets a third, then a taper hands out the
remainder newest-first, up to 5 / 4 / 3 / 2 by rank. Recency decides how many bullets a
role gets and retrieval order decides which, so a role still leads with its most
job-relevant work. Experience groups print newest-first too, since the allocation would
otherwise be invisible to a reader going down the page.

Two cases the comparator gets right on purpose. A role with `endDate: 'present'` sorts
above every finished role whatever its start date — sorting on start date alone reverses
exactly the pair that matters, a 2021 job still held against one that ended in 2023. And a
role with no usable dates sorts **last**, because it cannot honestly claim to be current,
but keeps its floor allocation: it loses the taper, never its place on the resume, and
reaches zero only when the allowance is too small to seat every role at all. The real fix
for those rows is #4, upstream.

The allowance stays a ceiling rather than a quota. Two roles on an 11-bullet budget spend
9 and leave the rest to the tail sections, instead of putting a fifth bullet on a
three-month internship.

### 9. Phone number missing
Empty in `contact_info`. Research lists incomplete contact details as a direct rejection
cause, and the self-test only warns on it.

**Fix.** Promote missing phone to a visible profile warning. It is genuinely absent from
the portfolio, so this is a prompt-the-user issue, not an extraction bug.

### 10. Per-role location never captured
`RoleRecord.location` exists but extraction never fills it and the renderer never shows
it. Research recommends city/country per role.

**Fix.** Extract it, render it beside the company.

---

## S3 — Polish

### 11. Near-duplicate skills
97 skills, 96 after normalisation — currently only "C"/"C++", which is correct. Worth a
normalisation pass before the list grows.

**Fixed.** `lib/skills/identity.ts`, following the normalize -> identity -> merge -> dedupe
shape of `sync/roles.ts` and `sync/education.ts`. What differs is the identity step. Roles
and education could reduce algorithmically because their noise is structural — legal
suffixes, parentheticals, punctuation — and skill names have no such structure. Every
algorithm that looks like it works destroys a real distinction: strip a "js" suffix and
"JS" reduces to nothing, strip punctuation and C / C++ / C# become one language, loosen
edit distance far enough to catch Postgres/PostgreSQL and it also catches Ruby/Rust. So
identity comes from a curated alias table and nothing else — short, auditable, and every
entry a decision someone made rather than a threshold that moved. Anything absent from the
table is its own skill, which is the safe default: failing to merge two spellings costs one
duplicated line, while merging two different skills puts a language on the resume the
person has never written.

Pairs deliberately kept apart, each one table entry away from being wrong:
Java/JavaScript, JS/Java, C / C++ / C#, R/Ruby and R/Rust, Go/Godot, Angular/AngularJS,
React/React Native, Next.js/Nest.js, SQL/PostgreSQL, and TS/TypeScript. The last is not
merged because "TS" reads as TypeScript in a frontend list and as nothing in particular
anywhere else, and the point of a curated table is to decline the coin-flips. Bare "next"
is out of the table for the same reason — it is an ordinary English word.

Three consumers. `assemble.ts` dedupes the Skills section after ordering, so the survivor
of "React"/"React.js" is the spelling the posting asked for, and names print canonically.
`quality/skills.ts` adds canonical forms to the profile vocabulary and tries every spelling
of a keyword — additive only, so it can never manufacture a claim the profile does not
already make. `quality/keywords.ts` feeds aliases into the 70% gate, which previously
counted a resume saying "Go" as missing a posting's "Golang". `retrieval/rank.ts` was left
alone deliberately: its keyword overlap is a soft ordering nudge feeding the relevance
floor, and widening it there changes what survives filtering for no measurable gain.

### 12. Embeddings are a dead code path
`pgvector` is unused; `cosineSimilarity` exists and nothing populates `embedding`, so
hybrid retrieval silently degrades to lexical-only. Works, but the code implies more than
it does.

**Fix.** Either populate embeddings or delete the branch. Do not leave it implying
capability it lacks.

**Fixed — deleted.** What was checked first: no caller anywhere passes `RankOptions` beyond
`relevanceFloor` — `pipeline/run.ts`, `app/api/baseline/route.ts`, `scripts/smoke.mts` and
`tests/sections.test.mts` are every call site; nothing writes `profile_record.embedding`,
which appears exactly once in the codebase, in the schema; `ProfileRecord` has no
`embedding` field, so `record_embedding` read it through a cast that could only ever return
null; and `embeddingScore` was consumed by nobody. Every ranked record therefore scored 0
on that half of the formula, and the 0.6/0.4 weights collapsed to pure keyword overlap on
every run the app has ever made. Removed: `cosineSimilarity`, `KEYWORD_WEIGHT`,
`EMBEDDING_WEIGHT`, the `jobEmbedding`/`embeddings` options, `RankedRecord.embeddingScore`
and `record_embedding`. The module header now says ranking is lexical.

The `embedding` jsonb column stays. Dropping it is a migration against the live database
for no functional gain, and this pass made no database writes at all. It is nullable,
unwritten, and now unread — a note in the schema rather than a code path implying a
feature.

### 13. Licensed-parser validation tier never integrated
Task 6.9 (Affinda/RChilli) is still open, so the strongest ATS check is unused.

---

## Resolved since the audit

- **#1 duplicate roles** — fixed. Roles now carry the same normalised identity education
  has (`lib/sync/roles.ts`), and the live profile was cleaned 16 -> 10 rows, matching
  `experienceData.ts` exactly. Three bullets were repointed at surviving rows before any
  deletion rather than orphaned.
- **#3 merged titles** — fixed. "AI Intern / Full Stack Developer / Project Manager"
  splits and collapses onto the three real DiffuseAI rows instead of adding a fourth.
- **#4 roles with no start date** — fixed as a consequence: the dateless rows merged into
  their dated counterparts.
- **#9 phone** — supplied by the user, stored as `+91 80124 84177`. International form is
  deliberate: a bare ten-digit number gives a parser no country to attach it to.
- **#10 per-role location** — fixed. The data was in the source all along
  ("Chennai, Tamil Nadu, India · On-site", "Remote") and extraction was discarding it.

### #2 is not a code defect
Checked the source directly: `experienceData.ts` carries only title, company, location
and period, and `Experience.tsx` is presentation. **No per-role accomplishment text
exists anywhere in the portfolio.** The extractor was right not to invent any. This is
fixed by writing bullets — in the portfolio, or by hand in the app — not by better
parsing. Same for #5: the projects genuinely state no outcomes.

## Fixed in the length / distribution / normalisation pass

| Was | Now |
|---|---|
| Nothing scored resume length (#7) | `quality/length.ts` — a 210-word floor and the page budget as ceiling, priced as one formatting rule |
| Bullets capped globally, so an old internship could outrank the current job (#8) | Floor-then-taper allocation by recency; `present` beats every finished role; undated roles keep their floor |
| "React", "React.js" and "ReactJS" were three skills (#11) | Curated alias table in `skills/identity.ts`, consumed by the Skills section, the skills sub-score and the keyword gate |
| A weighted embedding term nothing populated (#12) | Deleted; ranking is lexical and now says so |

## Already fixed this session

| Was | Now |
|---|---|
| Resume claimed skills the user lacks ("developers", 8 SEO tools) | One-directional whole-phrase matching in `lib/quality/vocabulary.ts` |
| Keyword gate counted substrings ("React" matched "reacts to") | Word-boundary matching, proper-noun-aware plurals |
| Self-test searched the whole document for skills | Isolates the Skills region between headings |
| Relevance floor emptied a resume; it scored 9.7/10 | Floor relaxes in stages; empty resume now fails formatting |
| Education duplicated three ways, Bachelor's missing | Credential normalised to level, institution to leading words |
| Blogs, research and engagements excluded from sync | Re-included; only raw post bodies skipped |
| No Summary, Publications, Awards, Languages, Volunteering, Interests | Seven new record types with ATS-recognised headings |

## Fix order

1. **#1, #2, #3** — role deduplication, bullets, split titles. Together these are why the
   resume has no Experience section, which is the single biggest quality problem.
2. **#4, #6** — date correctness, since bad dates actively mislead a parser.
3. **#7, #8** — length and bullet distribution, once there is content to distribute.
4. **#5, #9, #10** — surface the data gaps that only the user can fill.
5. **#11, #12, #13** — polish. #11 and #12 are done; #13 remains.
