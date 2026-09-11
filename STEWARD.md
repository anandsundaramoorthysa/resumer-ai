# Profile Steward — AI on the profile page, and an agent between every write

Status: planned 2026-09-11. This is the research and the design; the code references it.

## 1. What was asked

> For Profile page need AI and also add one AI agent in between adding data manually or
> any other way to perfect the data.

Read as two things:

1. **AI on the profile page** — help filling the profile, and help fixing what is in it.
2. **An agent between input and storage** — whatever path a fact takes into the profile
   (typed, imported, synced, answered), something checks it and makes it right before it
   becomes the fact every resume is built from.

## 2. Research

### 2.1 How data enters the profile today (six paths, no quality gate on any)

| Path | Where | AI today | Written as |
|---|---|---|---|
| Typed in a form | `app/profile/record-editor.tsx` → `lib/profile/records.ts` | none | `manual` |
| Bullet editor | `app/profile/bullet-editor.tsx` → `createBullet` | none (advisory checks only) | `manual` |
| Resume import | `app/import` → `lib/import/parse.ts` → `commit.ts` | extraction only | `ai-import` |
| LinkedIn export | `lib/import/linkedin.ts` → `commit.ts` | none | `linkedin` |
| Portfolio sync | `lib/sync/parse.ts` → `applyParsedProfile` (pending review) | extraction only | `github-sync` |
| "I do have that" / enrichment answers | `lib/profile/claim.ts`, `lib/server/enrichment.ts` | extraction + grounding | `manual` |

Every path ends in a raw insert. Nothing normalises spelling, notices that a new skill is
an existing one under another name, or questions a record filed under the wrong type.

### 2.2 What the owner's real profile shows (191 records, read-only audit)

- **Skills (103).** Duplicates the identity table cannot see: ML / Machine Learning;
  NLP / Natural Language Processing (NLP); RAG / RAG pipelines / Retrieval-Augmented
  Generation (RAG); LLM / LLMs / Large Language Models (LLM); Vector Database / Vector
  Databases; AI / Artificial Intelligence (AI) / AI technologies; Chatbot / Chatbot
  Development. Only React = React.js merges today. Categories wrong: Machine Learning as
  "framework", Full-Stack Development and SEO as "soft-skill", segmentation as "tool".
  Lowercase entries: segmentation, classification, clustering, time series, statistics.
- **Bullets (13).** A near-duplicate across two roles ("Integrated open-source AI models
  into web applications using Flask" / "Worked with open‑source AI models and integrated
  them…"), with non-breaking hyphens stored in the data. Weak openers: Helped, Offered,
  Worked with, Contributed to. One bullet says nothing but the dates ("Freelanced through
  March 2026."). None has a scale or an outcome.
- **Projects (32).** Zero impact metrics. First/second person ("my skills", "test your
  internet speed"). A research paper filed as a project, with "Climate Change" and
  "Urbanization" as its stack. One with an empty stack.
- **Achievements (6).** Every description repeats the title word for word.

### 2.3 Outside practice

- **Skill normalisation**: map every spelling to one canonical entry; synonym variants
  otherwise fragment a profile ([Lightcast taxonomy](https://kb.lightcast.io/en/articles/7216059-lightcast-skills-taxonomy),
  [JobsPikr on normalising skills](https://www.jobspikr.com/blog/normalising-data-job-titles-skills-locations/)).
- **Human in the loop**: the agent proposes, the person approves; show the diff, not only
  the output; keep approval queues for changes with real cost ([AI UX Playground](https://aiuxplayground.com/guides/how-to-design-human-in-the-loop/)).
- **Bullets**: action verb first, context, outcome; drop "responsible for / assisted
  with"; no pronouns ([Resume.io XYZ](https://resume.io/blog/xyz-resume-format)).
- **Grounding agents**: entity-level hallucination is the failure mode — every entity in
  the output must appear in the input, checked in code, not trusted to the prompt
  ([AgentLTL](https://arxiv.org/pdf/2607.02599)).

### 2.4 Constraints this has to live inside

- **NFR-8, no invented facts.** The steward may reword, re-file, merge and remove; it may
  never add a name, number, date or tool. Checked by `lib/generate/grounding.ts`, the
  same guard the resume rewrite uses. Missing facts become questions, answered verbatim.
- **Netlify's 30 s function ceiling.** One request = one bounded model call. A whole-
  profile review is driven section by section from the browser, like the importer.
- **Provider behaviour** (see memory `groq-schema-breaks-chain`): every schema field
  required, no optionals; Fireworks structured ≈ 3–4 s, Groq text path ≈ 2 s.
- **Daily AI budget** applies; every call is counted.
- **Provenance**: anything the user applies becomes their own `manual` record with an
  audit row saying the steward proposed it.

## 3. Design

Two layers, because two different kinds of problem exist.

### Layer 1 — Tidy (deterministic, automatic, every write path)

`lib/steward/tidy.ts` — `tidyRecordData(type, data)`. Only changes that cannot alter a
fact: Unicode look-alike hyphens and non-breaking spaces to plain ones, whitespace
collapsed, a skill's canonical spelling, a stack de-duplicated by skill identity, a
description dropped when it only repeats the title, "Sep 2023" written as `2023-09`.
Called by every writer: `records.ts` (forms, bullets, answers), `commit.ts` (import,
LinkedIn, claims) and `applyParsedProfile` (sync). Silent, because there is nothing to
decide.

### Layer 2 — Review (rules + one AI agent, human-approved)

A **suggestion** is one proposed change with its reason and a before/after:

| kind | meaning | applied by |
|---|---|---|
| `fix` | new value for one field (wording, casing, category) | `updateTypedRecord` / `updateBullet` |
| `merge` | these records are one thing; keep one | delete the others |
| `move` | wrong record type (project → publication) | create as the new type, delete old |
| `remove` | adds nothing (dates-only bullet, duplicate bullet) | delete |
| `ask` | a fact is missing; the user types it | field set to their words, verbatim |

- `lib/steward/rules.ts` (pure) finds what code can prove: duplicate skills by identity,
  acronym-in-parentheses, singular/plural and a short abbreviation table; near-duplicate
  bullets; dates-only bullets; hygiene on existing data; empty stacks, undated
  certifications, reversed date ranges.
- `lib/steward/agent.ts` asks the model what code cannot judge: first-person or filler
  wording, weak openers, wrong skill category, wrong record type. One structured call
  per batch.
- `lib/steward/verify.ts` (pure) is the gate on the agent: the record and field must
  exist; a rewrite may not introduce a number or proper noun absent from the record and
  profile (`findUngroundedTokens`), may not grow past the original, may not add a
  pronoun; a category must be from the enum; a move only between compatible types.
  Anything failing is dropped and counted, never shown.
- Dismissed suggestions are remembered (`steward_dismissal`, keyed by a fingerprint of
  the record's content hash and the proposed change), so a re-review does not nag; an
  edit to the record changes the fingerprint and lets it be judged again.
- Applying re-reads the record first: if it changed since the suggestion was made, the
  suggestion is refused as stale rather than applied over the edit.

### Where it sits

1. **Profile page → "AI profile assistant"** card at the top:
   - **Review my profile** — runs section by section (skills, experience, projects,
     education & credentials, everything else), shows suggestions grouped with
     before/after, Apply / Dismiss each, and one "Apply all N quick fixes" for the
     rule-proven hygiene and casing fixes.
   - **Add with AI** — describe something in plain words; the claim extractor turns it
     into records, grounding drops anything not said, tidy and a duplicate check run,
     and the user ticks what to add.
2. **Manual save** — on Add/Save in any record form or the bullet editor, the steward
   checks the value against the profile first (duplicate, casing, wording). Nothing to
   say: it saves straight away. Something to say: the suggestions appear inline with
   "Use this" per item, and Save or "Save as typed". If the model is slow or down, it
   saves as typed — the agent never blocks a save.
3. **Import review** — after extraction, candidates already in the profile are
   unticked and labelled, and wording fixes are offered per row before commit. The check
   runs after the list is on screen, never in front of it.
4. **Portfolio sync queue** — "Review with AI" runs the same review over the pending
   items, so a fix is made before approval rather than after.

## 4. What the live runs changed

Measured against the owner's real profile (191 records) on production:

- **Skills are rule-only.** Asked about a hundred skills the model mostly proposed moving
  one between categories a resume barely distinguishes, at five model calls per review.
  The rules already merge and spell them. Dropping it shortened the review and removed the
  noisiest suggestions.
- **12 s per provider attempt, not the whole budget.** Given all 22 s, a slow Fireworks
  spent it alone and the four providers behind it were never asked, so a section came back
  "the AI part could not run". Groq answers the same call in about two.
- **Batches are small** (10–20 records) and **two requests run at once**; three earned
  rate-limit refusals from the shared chain. A batch the providers cannot serve is retried
  once at the end.
- **Quick fixes apply five per request.** Twenty in one server action exceeded the host's
  thirty seconds and returned 502 mid-apply.
- **Applying invalidates neighbours.** A fix rewrites the record it touches, so any other
  suggestion about that record was judged on words that no longer exist: the page drops
  them and says so, rather than offering a button whose only outcome is a refusal.
- A whole review of that profile: about 135 seconds, ~46 suggestions.

## 4a. The sixth skill category

Added 2026-09-11. The five categories (language, framework, tool, platform, soft-skill)
had no home for a technique, so every parser filed Machine Learning as a framework,
Statistics as a tool, and Web Development and SEO as soft skills. `method` is that home.

What fills it is `lib/skills/categories.ts` — a table, not a model, for the reason in §4:
asked to sort a hundred skills the model produced a long list of defensible-either-way
changes at five calls a review. The table answers only where the answer is not in doubt
(43 of the owner's 103 skills; 38 of them were filed wrong), the steward proposes each as
an ordinary suggestion, and a form saving a skill into a category the table disagrees with
says so first. On a resume, a method no Skills rule already places gets a Methods and
Practices row instead of falling into Other.

## 5. Test plan

- Unit: tidy, every rule (fixtures taken from the real profile's defects), the verifier
  (an invented figure, an invented company, an off-enum category, a stale apply),
  fingerprint stability.
- Live agent evaluation against the owner's exported profile, read-only, iterating the
  prompt until the suggestions are right and nothing is invented.
- End to end in a real browser against production, on a throwaway copy of the profile:
  review, apply a merge / a rewrite / a move, dismiss, re-review; manual add of a
  duplicate and a first-person description; Add with AI; import a resume; phone width;
  console clean. Loop until it passes, then delete the throwaway.
