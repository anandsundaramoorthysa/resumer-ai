# Resumer AI — end-to-end test plan

**Version:** 2026-09-07 · **Against:** `6862307`

---

## How to use this

Every case has an ID, preconditions, steps, and an expected result written so that
"pass" is unambiguous. Record the outcome in the rightmost column of the summary table at
the end.

**Read this first.** Most of this application is already covered by automated tests, and
running those takes four minutes. Repeating that work by hand is waste. The manual cases
here are deliberately restricted to what a machine in this repo genuinely cannot check:

- anything requiring a **browser** (rendering, focus, keyboard, mobile layout)
- anything requiring a **third party to send something** (a real email arriving, a GitHub
  consent screen, an OAuth round trip)
- anything requiring **judgement** ("does this resume read as though a person wrote it",
  "would a recruiter believe this")
- anything requiring a **deployed environment** rather than localhost

So run §0 first. If it is green, you already know the engine works, and the manual pass
is about the parts a human has to look at.

---

## §0 — Automated gate (run this before anything else)

| ID | Command | Expected |
|---|---|---|
| A-1 | `npm run typecheck` | no output |
| A-2 | `npm run lint` | 0 errors (warnings are acceptable) |
| A-3 | `npm test` | `All 16 suites passed.` |
| A-4 | `npm run build` | `Compiled successfully` |
| A-5 | `npx tsx --tsconfig scripts/tsconfig.json scripts/smoke.mts` | `18 checks passed.` |
| A-6 | `… scripts/verify-auth.mts` | `all checks passed` |
| A-7 | `… scripts/verify-crud.mts` | `all checks passed`, profile left at its original record count |
| A-8 | `… scripts/verify-linkedin.mts` | `all checks passed`, profile left at its original record count |
| A-9 | `… scripts/verify-token-encryption.mts` | `all checks passed`, GitHub HTTP 200 |
| A-10 | `… scripts/verify-mail.mts` | reports the configured provider and authenticates |

**Stop if any of these fail.** A red A-case makes every manual result below unreliable,
because you would be testing a build that is already known to be broken.

What §0 already proves, so no manual case repeats it: password hashing and strength
rules, disposable-address and MX policy, single-use link tokens, rate-limit thresholds,
CRUD for all twelve record types, LinkedIn CSV/ZIP parsing, token encryption and refresh,
GitHub App JWT signing, ATS heading and date rules, grounding over 3,000 generated pairs,
role deduplication, and the section assembler.

---

## §1 — Environment

### E-1 · Runtime configuration is complete

**Steps** — open `/api/health` on the deployed site.

**Expected** — `ok: true`, and:

| Field | Expected | If not |
|---|---|---|
| `auth.ready` | `true` | sign-in is broken; nothing below will run |
| `database.usable` | `true` | as above |
| `ai.count` | ≥ 1 | drafting will fail |
| `security.tokenEncryption` | `true` | tokens are stored in plaintext |
| `security.cronEnabled` | `true` | the nightly sync silently refuses every request |
| `mail.configured` | `true` | email sign-up is hidden |
| `siteUrl` | the deployed host | confirmation links will point at localhost |

No field anywhere in this response may contain a secret **value** — only booleans,
lengths and provider names. If one does, that is a defect, not a test result.

### E-2 · Security headers are served

**Steps** — `curl -sI https://<host>/` and `curl -sI https://<host>/reset-password?token=x`

**Expected** — on `/`: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Strict-Transport-Security`, `Referrer-Policy: strict-origin-when-cross-origin`, and a
`Content-Security-Policy` containing `frame-ancestors 'none'`.
On `/reset-password`: `Referrer-Policy: no-referrer`.

**Why it matters** — the token rides in the query string, and the page loads stylesheets
from two font CDNs. Without `no-referrer` those third parties receive the reset URL.

### E-3 · The page renders correctly under that CSP

**Steps** — load `/` in a browser with devtools open. Read the console.

**Expected** — no `Content Security Policy` violation. Fonts render as the intended
faces, not fallbacks.

**Why manual** — a CSP that blocks a stylesheet produces a page that still returns 200.
Only a browser reports the violation.

---

## §2 — Authentication

### AU-1 · GitHub sign-in

**Steps** — sign out. `/sign-in` → *Continue with GitHub*. Complete the consent.

**Expected** — redirected to `/` signed in. On the consent screen, note the scopes:

- **no GitHub App configured** → mentions repositories (`repo`)
- **GitHub App configured** → identity only, **no mention of repositories**

Record which you saw. This is the single most visible outcome of the App migration.

### AU-2 · Google sign-in

**Precondition** — `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` set.

**Steps** — sign out. `/sign-in` → *Continue with Google*.

**Expected** — signed in; `/profile` shows the same profile if the email matches an
existing account, rather than an empty second one.

**Skip if** — Google is not configured; the button should then be **absent**, not present
and broken.

### AU-3 · Email sign-up and verification — the full round trip

**Steps**
1. `/sign-in` → *Create account*. Use a real address you can read.
2. Type a short password, e.g. `abc123`. Observe the live rules.
3. Change it to a passphrase, e.g. `harbour wall mist 2026`. Submit.
4. Open the email. Click the link.
5. Return to `/sign-in` and sign in with those credentials.

**Expected**
- step 2: the form states what is missing and **Create account** stays disabled
- step 3: the reply is *"If that address can have an account here, a link is on its way…"*
- step 4: the email is plain text, the link is on its own line, and it confirms
- step 5: signed in

**Then**: click the same link a second time. It must say the link has already been used
and tell you how to get another.

**Why manual** — that an email is *actually delivered*, and lands in the inbox rather
than spam, cannot be checked from inside the repo.

### AU-4 · An unconfirmed account cannot sign in

**Steps** — create an account and, **without** clicking the link, try to sign in.

**Expected** — refused, with a message that does **not** state the account exists or that
it is unconfirmed. Use *Resend the confirmation email*; confirm; sign in; it works.

### AU-5 · Failures are indistinguishable

**Steps** — attempt sign-in three ways: wrong password on a real account; an address with
no account at all; correct password on an unconfirmed account.

**Expected** — **the same message in all three cases**, and roughly the same response
time. A different message, or one noticeably faster, is an account-enumeration oracle.

### AU-6 · Password reset

**Steps** — `/forgot-password` with a real address → open the email → set a new password →
sign in with the new one → confirm the old one now fails.

**Expected** — as described. Then request a reset twice in a row and confirm **only the
newest link works**; the first must report itself used or expired.

### AU-7 · Reset reveals nothing about an unknown address

**Steps** — `/forgot-password` with an address that has no account.

**Expected** — the identical neutral sentence, at roughly the same speed. No email
arrives.

### AU-8 · Disposable addresses are refused

**Steps** — attempt sign-up with `someone@mailinator.com` and with `x@yopmail.com`.

**Expected** — refused, with a reason phrased in terms of *the user's* interest ("your
profile is the only record of your career this holds…"), not policy language.

### AU-9 · Brute force is stopped

**Steps** — submit ten wrong passwords for a real account in quick succession, then the
**correct** one.

**Expected** — the correct password is **also refused** once the limit is passed. Wait
fifteen minutes, or clear `auth_attempt` for that address, and it works again.

> This is also enforced on `/api/auth/callback/credentials`, which is the path an attacker
> would actually use. To check that path rather than the form, post directly to it — the
> limit must apply there too.

### AU-10 · A successful sign-in clears the counter

**Steps** — four wrong passwords, then the correct one (succeeds), then six more wrong
ones, then the correct one again.

**Expected** — the final sign-in **succeeds**. Ten failures without the intervening
success would have locked the account, so this proves the counter reset.

---

## §3 — Portfolio connection

### PC-1 · Connect a repository (OAuth path)

**Precondition** — no GitHub App configured.

**Steps** — `/settings/portfolio`, enter `owner/name`, save.

**Expected** — accepted, the repo name shown. A repository you do not have access to must
be refused with a message naming the problem, not a stack trace.

### PC-2 · Install the GitHub App

**Precondition** — `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG` set.

**Steps** — `/settings/portfolio` → *Install on GitHub* → select **only** the portfolio
repository → approve.

**Expected**
- returned to `/settings/portfolio` with *"Installed on &lt;account&gt;."*
- the panel lists the account and the repositories it can read
- it states that read access is granted and **nothing long-lived is stored**
- `/api/health` shows `security.githubApp: true` and the scope without `repo`

### PC-3 · Installing on the wrong repository is caught

**Steps** — change the installation to a repository that is **not** your portfolio.

**Expected** — the panel warns that the connected repo is not one the app can read, and
says sync will fall back to the older broader access. It must not silently appear fine.

### PC-4 · Uninstalling is noticed

**Steps** — uninstall the app from GitHub → reload `/settings/portfolio`.

**Expected** — the panel no longer claims access. (Requires the webhook to be configured;
without it, this is expected to fail — record that as *N/A, webhook not set*.)

### PC-5 · An installation cannot be stolen

**Steps** — while signed in as user A, open
`/api/github/install?installation_id=<some other number>`.

**Expected** — an error, and **no** installation recorded against A. The id in that URL
is browser-supplied and must be confirmed with GitHub before it is trusted.

### PC-6 · Sync reads the repository

**Steps** — `/settings/portfolio` → run a sync. Watch the progress.

**Expected** — steps complete without a timeout; the profile record count rises or stays
the same; no step exceeds ten seconds.

### PC-7 · An unchanged repo is not re-parsed

**Steps** — run sync twice without pushing to the repo.

**Expected** — the second run reports nothing to do and finishes almost immediately.

---

## §4 — Profile

### PR-1 · Every record type can be created, edited and removed

**Steps** — on `/profile`, for **each** of: skill, project, education, certification,
publication, writing, award, achievement, volunteering, language, interest, summary —
add one, edit it, remove it.

**Expected** — each appears in its own section immediately; edits persist across a
reload; removals disappear. Required fields disable the button until filled, naming what
is missing.

> §0/A-7 already proves this against the database for all twelve types. What is being
> checked **here** is the browser: that the form renders, the section appears in the
> right place, and the result is visible without a manual refresh.

### PR-2 · A duplicate is reported in plain words

**Steps** — add a skill, then add the identical skill again.

**Expected** — *"You already have this saved."* Not a database error, and not a silent
second copy.

### PR-3 · Experience bullets

**Steps** — on a role, add an accomplishment. Fill only *What did you do?*. Then fill
scale and outcome.

**Expected** — the live checks show which of the three parts are missing; the composed
sentence updates as you type; **Save** works even with checks unmet, with the note that
a real accomplishment without a number still belongs on a resume.

**Also confirm** — there is **no** "write this for me" button anywhere on this form.
Everything else in the product is built on nothing being invented.

### PR-4 · The gap summary is honest

**Steps** — read the panel at the top of `/profile`.

**Expected** — it names roles with no accomplishments recorded and projects with no
measurable outcome, and says these are facts only you have. If your profile is complete,
no panel appears at all.

### PR-5 · Provenance is shown

**Expected** — each record is labelled `typed`, `portfolio`, `imported` or `LinkedIn`.
Nothing says merely "synced" for a record that came from an import.

---

## §5 — Import

### IM-1 · Resume import (PDF)

**Steps** — `/import` → upload a real resume PDF → wait → review → untick something →
confirm.

**Expected**
- progress advances section by section
- the review list is grouped by type, including publications, awards, languages and
  volunteering — not only the five oldest types
- the unticked item is **not** in the profile afterwards
- re-importing the same file adds nothing

### IM-2 · A scanned PDF is refused clearly

**Steps** — upload a photographed or scanned resume with no text layer.

**Expected** — a message saying it cannot be read and what to do instead. Not a crash,
and not an empty review list with no explanation.

### IM-3 · LinkedIn export

**Steps** — request your data at *LinkedIn → Settings → Data privacy → Get a copy of your
data*, tick the larger set, wait for the email, upload the `.zip` at `/import`.

**Expected**
- read in about a second, with no model involved
- positions become roles, and their **descriptions become bullets, word for word**
- a position with no description still becomes a role, and a note says so
- skills, education, certifications, languages, projects, publications, honors and
  volunteering all appear
- everything is labelled `LinkedIn` in the profile afterwards

**Why manual** — §0/A-8 proves the parsing against a synthesised export. Only a real
archive proves LinkedIn still exports the file names and columns this expects.

### IM-4 · A wrong file is refused politely

**Steps** — upload a random `.zip` that is not a LinkedIn export.

**Expected** — a message saying no recognised export files were found, naming the correct
download. Not a stack trace.

---

## §6 — Drafting a resume

### DR-1 · From a pasted job description

**Steps** — from `/`, paste a full JD for a role your profile genuinely fits. Draft.

**Expected**
- live progress through: sync → understand → retrieve → draft → score → finalize
- the score panel shows keyword coverage, formatting, evidence and skills separately
- either it reaches **≥ 8.5/10**, or it halts and **names the specific missing
  requirements**
- both a PDF and a DOCX are produced

### DR-2 · The gate iterates

**Expected** — where the first attempt scores below 8.5, the log shows a revision and a
re-score, up to four attempts. It must not silently accept a low score.

### DR-3 · An honest halt

**Steps** — draft against a role your profile clearly does not fit (e.g. a senior
technical SEO role if you have no SEO evidence).

**Expected** — it stops below the threshold and states which requirements are absent from
your profile, saying no rewrite can close that honestly.

**This is a pass, not a failure.** A high score here would mean the system had invented
experience — which is the one thing it must never do.

### DR-4 · Nothing is invented

**Steps** — read the generated resume line by line against your profile.

**Expected** — every number, employer, tool and claim traces to something you recorded.
Any figure that does not appear in your profile is a **critical** defect.

**Why manual** — this is the product's central promise, and the only complete check is a
person who knows the truth reading the output.

### DR-5 · From a URL

**Steps** — paste a job posting URL.

**Expected** — the posting is fetched and understood, or a clear message asks you to
paste the text. A silent wrong answer is a defect.

### DR-6 · From a bare title

**Steps** — enter only `Full Stack Developer`.

**Expected** — it proceeds using a generic understanding of the role, and says the input
was thin rather than pretending it had a full posting.

---

## §7 — The output

### OU-1 · The PDF is ATS-safe

**Steps** — open the PDF and **select all → copy → paste into a plain text editor**.

**Expected**
- the text comes out in reading order
- no text is missing
- contact details are in the body, **not** in a header or footer
- headings are conventional (`Experience`, `Education`, `Skills`…), not invented
- no icons, no tables, no multi-column layout, no text inside images
- hyperlinks are real links and the visible text is readable without them

**Why manual** — this simulates what a parser does. An automated round-trip is in §0, but
reading order and visual layout need eyes.

### OU-2 · The DOCX matches

**Steps** — open the DOCX in Word or Google Docs.

**Expected** — same content, same section order, same headings. No corrupt-file warning.

### OU-3 · Filenames are professional

**Expected** — something like `Anand-Sundaramoorthy-Technical-SEO-Lead.pdf`. Not
`resume_final_v2.pdf`, and no stray quotes or spaces.

### OU-4 · Editing the preview

**Steps** — on `/resume/<id>`, edit a line, save, re-export.

**Expected** — the change is in both files. The edited line loses its source attribution,
because once you rewrote it, it is your sentence and the system can no longer vouch for
it.

### OU-5 · Oversized input is refused

**Steps** — `PATCH /api/resume/<id>` with a `text` of 100,000 characters.

**Expected** — HTTP 400 naming the field. Not stored.

### OU-6 · Cover letter and interview prep

**Steps** — on a resume with a job attached, generate each.

**Expected** — both produced; the letter references the actual company and role; neither
invents experience. On a baseline resume with no job, both are refused with a reason.

---

## §8 — Authorization (must all fail closed)

### AZ-1 · Another user's resume is unreachable

**Precondition** — two accounts, A and B; A has a resume snapshot.

**Steps** — as B, request `/resume/<A's id>`, `/api/resume/<A's id>`,
`/api/export/<A's id>`, and `PATCH /api/resume/<A's id>`.

**Expected** — 404 or "not found" on every one. **Any** of A's content appearing is a
critical defect.

### AZ-2 · Signed-out access is refused

**Steps** — signed out, request `/profile`, `/applications`, `/settings/portfolio`,
`/import`, and `POST /api/draft`.

**Expected** — redirect to sign-in, or 401. No data in any response body.

### AZ-3 · The dev harness is not exposed

**Steps** — on the **deployed** site, `POST /api/dev/e2e-draft` and `GET /api/dev/selftest`.

**Expected** — `404` from `e2e-draft`. It must never return profile data in production.

### AZ-4 · The cron endpoint requires its secret

**Steps** — `POST /api/cron/sync` with no header, and with a wrong `x-cron-secret`.

**Expected** — refused both times. It walks stored GitHub credentials; an open endpoint
here is serious.

### AZ-5 · The webhook requires a valid signature

**Steps** — `POST /api/webhook/github` with a body and no `x-hub-signature-256`.

**Expected** — `401`.

---

## §9 — Interface

### UI-1 · Mobile

**Steps** — at 375 px wide, walk `/`, `/profile`, `/import`, `/settings/portfolio`,
`/resume/<id>`.

**Expected** — no horizontal scrolling; every button reachable and at least 44 px tall;
no text clipped or overlapping.

### UI-2 · Keyboard only

**Steps** — using only Tab, Shift-Tab, Enter and Space, sign in, add a skill, and start a
draft.

**Expected** — focus is always visible, order is sensible, nothing is reachable only by
mouse.

### UI-3 · Both colour schemes

**Steps** — view in light and dark mode.

**Expected** — text is legible in both; no white-on-white or black-on-black; the status
colours (success, warning, danger) remain distinguishable.

### UI-4 · Slow and failing networks

**Steps** — throttle to *Slow 3G* and start a draft. Then go offline mid-draft.

**Expected** — progress keeps updating; going offline produces a stated error, not a
spinner that never resolves.

### UI-5 · Errors are sentences

**Expected** — across the app, every error a user can trigger reads as a sentence with a
next step. No stack traces, no SQL, no raw HTTP status.

---

## §10 — Recovery

### RE-1 · An expired GitHub token refreshes itself

**Steps** — set `expires_at` on your `account` row to a past timestamp, then run a sync.

```sql
update account set expires_at = extract(epoch from now())::int - 3600
where provider = 'github';
```

**Expected** — sync **succeeds**. The token is refreshed, re-stored encrypted, and
`expires_at` moves into the future.

**Why this case exists** — this exact situation was live and undetected: the token had
expired, sync had been failing silently for fourteen hours, and would have failed again
every eight hours indefinitely.

### RE-2 · Revoked access degrades honestly

**Steps** — revoke the app on GitHub, then attempt a sync.

**Expected** — a message saying access is gone and how to restore it. Not a crash, and
not a silent success that syncs nothing.

### RE-3 · An AI provider outage falls through

**Steps** — set an invalid `GOOGLE_GENERATIVE_AI_API_KEY` and draft.

**Expected** — the chain falls through to the next provider and the draft completes. The
log names the provider that failed.

### RE-4 · An empty profile does not produce a confident resume

**Steps** — with a new account holding no records, attempt a draft.

**Expected** — refused, or a very low score with the reason stated. A high score on an
empty profile is a critical defect.

---

## Summary

| § | Area | Cases | Pass | Fail | N/A | Notes |
|---|---|---|---|---|---|---|
| 0 | Automated gate | A-1…A-10 | | | | |
| 1 | Environment | E-1…E-3 | | | | |
| 2 | Authentication | AU-1…AU-10 | | | | |
| 3 | Portfolio | PC-1…PC-7 | | | | |
| 4 | Profile | PR-1…PR-5 | | | | |
| 5 | Import | IM-1…IM-4 | | | | |
| 6 | Drafting | DR-1…DR-6 | | | | |
| 7 | Output | OU-1…OU-6 | | | | |
| 8 | Authorization | AZ-1…AZ-5 | | | | |
| 9 | Interface | UI-1…UI-5 | | | | |
| 10 | Recovery | RE-1…RE-4 | | | | |

**Release blockers** — any failure in §8, DR-4 (something invented), OU-1 (the PDF does
not extract cleanly), or RE-4 (a confident resume from an empty profile). Everything else
is triaged on its merits.

**Tester:** ______________  **Date:** ______________  **Commit:** ______________
