# UI rework plan: "ink on paper, red-pen edit"

## 1. Tokens (replace @theme block and both dark blocks in app/globals.css; keep token NAMES, data-theme cookie mechanism, and duplicated dark blocks — a browser test needs both lists to match)
Light / Dark:
- paper #F3EDE0 / #17150F
- surface #FBF8F1 / #201D16
- ink #1B1A17 / #EFE8D8
- muted #5E574A / #A89F8C
- line (decorative hairline only) #D9D0BD / #3A352A
- rule (NEW, control borders, >=3:1) #7A7262 / #8A8171
- brand (vermilion) #B8301A / #FF6A4D ; brand-dark #8F2412 / #FF8A6E ; brand-tint #F2DDD2 / #3A1F17 ; on-brand #FFFFFF / #17150F
- blue (ink-blue secondary, focus ring) #1F3A5F / #9DB8E3 ; gold = alias of blue (drop gold usage)
- hl (highlighter, BACKGROUND only behind ink text) #F2D95C / #5A4A12
- success #1E6B39 / #7CC48F ; success-tint #DDE9D6 / #1E2A1C
- warning #85500A / #E5A24A ; warning-tint #F3E2C0 / #33260F
- danger #A3281A / #FF8A75 ; danger-tint #F4DAD0 / #3A1D16
Contrast (computed): ink/paper 14.92/14.95; muted/paper 6.13/6.96; brand/paper 5.18/6.45; on-brand/brand 6.04/6.45; blue/paper 9.84/9.04; ink/hl 12.31/7.10; rule/paper 4.08/4.74.
Rules: brand and blue carry text only on paper/surface, never on tints (use ink on brand-tint). Inputs/buttons use --color-rule, never --color-line. Focus ring: 2px solid var(--color-blue), offset 2px, :focus-visible.

## 2. Type (next/font/google in app/layout.tsx; delete Fontshare/Google <link> tags)
- Fraunces (variable, axes opsz+SOFT, normal+italic) -> --font-display (headings, resume artifact)
- Instrument_Sans 400/500/600/700 -> --font-sans
- IBM_Plex_Mono 400/500/600 -> --font-mono (scores, ledger numbers, § marks)
display:'swap'; variable class for each on <html>. 12px floor, 16px body; replace text-[11px]/text-[0.7rem] with text-xs. Display tracking-tight >= 2.25rem. Mono labels: uppercase tracking-wider text-xs.

## 3. Shape / spacing / motion
- rounded-none default; 2px only on inputs/chips; no rounded-2xl/xl/full pills except avatar.
- No bordered cards: hairline border-t border-line sections with mono "§ 01" margin label. Raised surfaces only for popovers.
- 4px base; section gaps 40/64px; reading column max-w-prose; page container 72rem.
- Controls min-h-11, border-rule. Primary = solid brand block, 2px ink offset shadow, translate(1px,1px) on active.
- Motion 150-250ms cubic-bezier(.2,.7,.2,1), transform+opacity only; one staggered load per page (40ms stagger, 6px rise); highlighter sweep = background-size 0->100% 400ms; wrapped by existing reduced-motion rule (+ scroll-behavior:auto).

## 4. Signature components
CSS classes owned by Package A in globals.css: .sheet .btn .btn-primary .field .hl .stamp .ledger .eyebrow .skip-link .sr-only .progress
- Landing (components/landing/*): H1 "One profile. Every role. No invented facts." + one CTA; right: <ResumeArtifact> static .sheet, 0.4deg tilt, Fraunces, two .hl keyword sweeps, one struck-through invented claim with vermilion margin note "No source, removed.", a [src: README §2] trace chip, <ScoreStamp> 8.7 rotated -6deg. Below: § 1 Import · § 2 Match · § 3 Verify · § 4 Export strip. Artifact aria-hidden + one-line caption. app/opengraph-image.tsx renders the artifact.
- App shell: flat paper sidebar, border-r border-line; active item = 3px vermilion left rule + semibold; square logo mark with check, flat brand; mobile nav panel max-h-[calc(100dvh-3.5rem)] overflow-y-auto; page header = .eyebrow (mono §) over Fraunces H1; skip link first focusable, targets #main.
- ScoreStamp (components/score-stamp.tsx): props score:number|null, bar=8.5, size. Square double-ruled box, mono number. Pass -> "VERIFIED" (success); below bar -> "BELOW BAR" (warning); null -> "UNSCORED" (muted). role="img" aria-label="Score 8.7 of 10, meets the 8.5 bar". Never colour-only.
- KeywordHighlight (components/keyword-highlight.tsx): props text, matched:string[], missing?:string[]. matched -> <mark class="hl">; missing -> dashed brand underline + sr-only "(missing)". Word-boundary, case-insensitive, escaped terms.
- Ledger table (.ledger): real <table> with sr-only <caption>, mono uppercase th scope=col, hairline rows, tabular numerals, score column = compact ScoreStamp, rows link w/ focus ring, sort buttons with aria-sort, status filter; wrap in overflow-x-auto.

## 5. Work packages (disjoint files; nobody edits globals.css except A; each adds id="main" tabIndex={-1} to its own <main>)
A (LANDS FIRST): app/globals.css, app/layout.tsx, app/opengraph-image.tsx, app/icon.svg, delete create-next-app SVGs in public/; theme-color meta follows manual theme (inline APPLY_THEME script updates meta); skip link; .sr-only/.progress helpers.
B Shell/system: components/app-header, desktop-sidebar, mobile-nav, account-menu, logo, theme-toggle, nav-icons, nav-links.ts, sidebar-state.ts, theme-state.ts; app/error.tsx, global-error.tsx, not-found.tsx, pending/page.tsx, app/loading.tsx.
C Landing/auth/dashboard: app/page.tsx, components/landing/*, components/setup-checklist.tsx, app/sign-in/*, forgot-password/*, reset-password/*, set-password/*, verify-email/*, components/password-input.tsx, password-status-card.tsx.
D Draft flow + resume review: components/draft-console.tsx, components/score-stamp.tsx, components/keyword-highlight.tsx, app/resume/[snapshotId]/* (+loading.tsx).
E Ledger/data pages: app/applications/*, app/profile/*, app/import/*, app/settings/*, app/activity/page.tsx, app/admin/approvals/*, loading.tsx in each.

## 6. Fixes mapped
A11y: remove outline-none on ~10 inputs (profile-assistant, status-select, bullet-editor, employer-panel, enrichment-question, record-editor, role-editor, reset/forgot forms) -> .field [E,D,C]; contentEditable -> <textarea aria-label> [D]; skip link/main ids [A,B,C,D,E]; next/font [A]; role=progressbar [D,E]; 12px floor [all]; editor padding p-4 sm:p-7 [D]; mobile nav max height [B].
UX: (1) editor autosave + beforeunload + undo + aria-live "Saved" [D]; (2) mark edited only when text changed, keep source trace [D]; (3) Retry button preserving input [D]; (4) immediate progress "Step 2 of 4 · 0:07" + spinner [D]; (5) fit decision at TOP, softer copy, KeywordHighlight for gaps [D]; (6) dashboard: one Recommended first step [C]; (7) disclose approval gate on /pending and sign-in [B,C]; (8) importer keeps parsed state on failure, collapse by section [E]; (9) one summary banner on profile [E]; (10) loading.tsx [B,D,E]; (11) applications ledger sort/filter [E]; (12) PDF primary, DOCX secondary [D].

## 7. Acceptance
typecheck/lint/test pass incl. token-parity browser test; text pairs match ratios, no text in --color-line; visible 2px blue focus ring everywhere; skip link first; one h1 + one main#main per page; no overflow at 320/360px, 44px targets; reduced-motion disables sweep+stagger; meaning never colour-only; no Fontshare/Google <link>; landing shows artifact, OG image renders, no stock SVGs; no rounded-2xl cards or 11px text; editor autosave + unload guard; failed draft retryable.
