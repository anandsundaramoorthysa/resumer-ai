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

### 8. Bullets are capped globally, not distributed per role
`bulletAllowance` caps the total (11 or 20). Research says 3–5 per role, most recent role
weighted highest, older roles tapered to 2–3.

**Fix.** Distribute the allowance across roles by recency instead of taking a flat top-N.

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

### 12. Embeddings are a dead code path
`pgvector` is unused; `cosineSimilarity` exists and nothing populates `embedding`, so
hybrid retrieval silently degrades to lexical-only. Works, but the code implies more than
it does.

**Fix.** Either populate embeddings or delete the branch. Do not leave it implying
capability it lacks.

### 13. Licensed-parser validation tier never integrated
Task 6.9 (Affinda/RChilli) is still open, so the strongest ATS check is unused.

---

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
5. **#11, #12, #13** — polish.
