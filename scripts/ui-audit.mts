/**
 * UI/UX capture harness.
 *
 * Drives a real Chromium over the running dev server, screenshots every page at every
 * viewport, and runs a set of machine-checkable UI assertions inside the page. The point
 * is that a human then reads the screenshots — the checks here exist to spare them the
 * measurements a screenshot cannot give: a scrollWidth, a contrast ratio, a 41px tap
 * target that looks fine.
 *
 * Nothing here depends on state set up by hand. It seeds its own verified password user,
 * signs in through the real form, and deletes that user on the way out — so a second run
 * after a fix produces a directly comparable report.
 *
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/ui-audit.mts
 *   npx tsx --tsconfig scripts/tsconfig.json scripts/ui-audit.mts --page=profile --viewport=phone
 *
 * Flags:
 *   --page=<slug>       only targets whose slug contains this (comma-separated)
 *   --viewport=<name>   only these viewports (comma-separated)
 *   --base=<url>        default http://localhost:3000
 *   --no-auth           skip seeding/sign-in; capture only what a signed-out visitor sees
 *   --empty-profile     seed the user with no records, to audit the empty states
 *   --keep-user         do not delete the seeded user (debugging only)
 */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page, type BrowserContext } from '@playwright/test';
import postgres from 'postgres';
import { hashPassword } from '../lib/auth/password';

/* ------------------------------------------------------------------ config -- */

const argv = process.argv.slice(2);
const flag = (name: string) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (name: string) => argv.includes(`--${name}`);

const BASE = flag('base') ?? 'http://localhost:3000';
const OUT = path.join(process.cwd(), 'screenshots');
const PAGE_FILTER = flag('page')?.split(',').map((s) => s.trim()).filter(Boolean);
const VIEW_FILTER = flag('viewport')?.split(',').map((s) => s.trim()).filter(Boolean);

const VIEWPORTS = [
  { name: 'phone-small', width: 320, height: 568, phone: true },
  { name: 'phone', width: 375, height: 812, phone: true },
  { name: 'phone-large', width: 414, height: 896, phone: true },
  { name: 'tablet', width: 768, height: 1024, phone: false },
  { name: 'laptop', width: 1280, height: 800, phone: false },
  { name: 'desktop', width: 1440, height: 900, phone: false },
  { name: 'wide', width: 1920, height: 1080, phone: false },
] as const;

interface Target {
  slug: string;
  url: string;
  auth: boolean;
  /** Extra interaction to reach a state a plain load does not show. */
  setup?: (page: Page) => Promise<void>;
}

const TARGETS: Target[] = [
  { slug: 'home', url: '/', auth: false },
  { slug: 'sign-in', url: '/sign-in', auth: false },
  { slug: 'forgot-password', url: '/forgot-password', auth: false },
  { slug: 'reset-password', url: '/reset-password?token=demo', auth: false },
  { slug: 'verify-email', url: '/verify-email?token=demo', auth: false },
  { slug: 'profile', url: '/profile', auth: true },
  { slug: 'import', url: '/import', auth: true },
  { slug: 'applications', url: '/applications', auth: true },
  { slug: 'settings-portfolio', url: '/settings/portfolio', auth: true },
  { slug: 'settings-application', url: '/settings/application', auth: true },

  // States a static load misses.
  {
    slug: 'sign-in-signup-weak',
    url: '/sign-in',
    auth: false,
    async setup(page) {
      await page.getByRole('tab', { name: 'Create account' }).click();
      await page.locator('input[type="password"]').fill('abc');
      await page.waitForTimeout(200);
    },
  },
  {
    slug: 'profile-form-open',
    url: '/profile',
    auth: true,
    async setup(page) {
      // The buttons read "+ Add a skill", so the name is not anchored at "Add".
      const add = page.getByRole('button', { name: /Add an? /i }).first();
      await add.waitFor({ state: 'visible', timeout: 10_000 });
      await add.click();
      // The form is open once its Cancel button exists; waiting on that rather than a
      // fixed delay keeps the capture honest if the section ever renders slower.
      await page.getByRole('button', { name: 'Cancel' }).first().waitFor({ timeout: 10_000 });
    },
  },
];

/* Dark mode is captured for every target, but only at two viewports — the palette is
   what is under test there, not the layout, which the light pass already covers. */
const DARK_VIEWPORTS = new Set(['phone', 'desktop']);

/* ------------------------------------------------------------------ finding -- */

type Severity = 'blocker' | 'major' | 'minor' | 'info';

interface Finding {
  page: string;
  viewport: string;
  scheme: 'light' | 'dark';
  check: string;
  severity: Severity;
  detail: string;
}

const findings: Finding[] = [];
const add = (f: Finding) => findings.push(f);

/* --------------------------------------------------------- in-page checks -- */

/**
 * Everything needing the DOM runs in one evaluate: a second pass would re-lay-out the
 * page and the numbers would no longer match the screenshot just taken.
 */
const IN_PAGE = String.raw`(() => {
  const out = { overflow: null, wide: [], touch: [], clipped: [], squeezed: [], contrast: [], alt: [], unlabelled: [], namelessButtons: [], headings: [], headingIssues: [] };
  const vw = window.innerWidth;

  /* The Next.js dev-mode error overlay is injected tooling, not the product. Everything
     below walks the real page only, so a dev-only element never lands in the report. */
  const isChrome = (el) => !!el.closest('nextjs-portal, [data-nextjs-toast], #__next-build-watcher');
  const walk = (sel) => [...document.querySelectorAll(sel)].filter((el) => !isChrome(el));

  /* 1. horizontal overflow ------------------------------------------------ */
  const docW = document.documentElement.scrollWidth;
  if (docW > vw + 1) {
    out.overflow = { scrollWidth: docW, viewport: vw };
    const seen = new Set();
    for (const el of walk('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 1) continue;
      let ancestorFlagged = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (seen.has(p)) { ancestorFlagged = true; break; }
      }
      if (ancestorFlagged) continue;
      seen.add(el);
      const cls = el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || '');
      out.wide.push({
        tag: el.tagName.toLowerCase(),
        cls: cls.slice(0, 120),
        right: Math.round(r.right),
        width: Math.round(r.width),
        text: (el.textContent || '').trim().slice(0, 60),
      });
      if (out.wide.length >= 8) break;
    }
  }

  /* 2. touch targets ------------------------------------------------------ */
  for (const el of walk('button, a, input, select, textarea')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    /* Visually-hidden controls (Tailwind's sr-only) are driven by a visible <label> that
       is measured on its own, so the 1x1 proxy is not the thing a finger has to hit. */
    if (cs.clipPath !== 'none' || cs.clip !== 'auto' || (r.width <= 2 && r.height <= 2)) continue;
    if (r.height < 44 || r.width < 44) {
      out.touch.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        w: Math.round(r.width), h: Math.round(r.height),
        text: (el.textContent || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 40),
        cls: String(el.className || '').slice(0, 90),
      });
    }
  }

  /* 3. clipped text ------------------------------------------------------- */
  for (const el of walk('body *')) {
    if (el.children.length > 0) continue;
    const txt = (el.textContent || '').trim();
    if (!txt) continue;
    const cs = getComputedStyle(el);
    // Visually-hidden text (Tailwind's sr-only) is clipped on purpose — that is the
    // technique, not a defect. It is read aloud, never shown, so it cannot be "cut off".
    if (cs.clipPath !== 'none' || cs.clip !== 'auto') continue;
    const hiddenX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const hiddenY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    const clipX = el.scrollWidth > el.clientWidth + 2 && (hiddenX || cs.textOverflow === 'ellipsis');
    const clipY = el.scrollHeight > el.clientHeight + 2 && hiddenY;
    if (clipX || clipY) {
      out.clipped.push({
        tag: el.tagName.toLowerCase(),
        axis: clipX ? 'x' : 'y',
        scroll: clipX ? el.scrollWidth : el.scrollHeight,
        client: clipX ? el.clientWidth : el.clientHeight,
        text: txt.slice(0, 60),
        cls: String(el.className || '').slice(0, 90),
      });
    }
  }

  /* 3b. text squeezed into a narrow ribbon --------------------------------
     Nothing overflows and nothing is clipped, so the checks above stay silent — but a
     paragraph rendered nine words tall and four characters wide is unreadable. It comes
     from a flex row whose siblings are flex-none and take the width first. */
  for (const el of walk('p, span, div, li, dd, td')) {
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
    own = own.trim();
    if (own.length < 40) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const lines = Math.round(r.height / lh);
    // Roughly how many characters fit on a line at this size.
    const perLine = r.width / (parseFloat(cs.fontSize) * 0.5);
    if (lines >= 4 && perLine < 22) {
      out.squeezed.push({
        tag: el.tagName.toLowerCase(),
        w: Math.round(r.width),
        lines,
        perLine: Math.round(perLine),
        parentW: Math.round(el.parentElement ? el.parentElement.getBoundingClientRect().width : 0),
        text: own.slice(0, 60),
        cls: String(el.className || '').slice(0, 90),
      });
    }
  }

  /* 4. contrast ----------------------------------------------------------- */
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const bgOf = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 0.999) return acc;
    }
    return acc && acc.a >= 0.999 ? acc : { r: 255, g: 255, b: 255, a: 1 };
  };

  const seenPairs = new Set();
  for (const el of walk('body *')) {
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
    own = own.trim();
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const eff = fg.a < 1 ? over(fg, bg) : fg;
    const px = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight) || 400;
    const large = px >= 18.66 || (weight >= 700 && px >= 14);
    const need = large ? 3 : 4.5;
    const got = ratio(eff, bg);
    if (got < need - 0.005) {
      const key = cs.color + '|' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '|' + px + '|' + weight;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      out.contrast.push({
        ratio: Math.round(got * 100) / 100,
        need,
        fg: 'rgb(' + Math.round(eff.r) + ',' + Math.round(eff.g) + ',' + Math.round(eff.b) + ')',
        bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
        px, weight,
        text: own.slice(0, 50),
        cls: String(el.className || '').slice(0, 90),
      });
    }
  }

  /* 7. alt text / accessible names --------------------------------------- */
  for (const img of walk('img')) {
    if (!img.hasAttribute('alt')) out.alt.push({ src: (img.currentSrc || img.src || '').slice(-70) });
  }
  const nameOf = (el) => {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return true;
    const lb = el.getAttribute('aria-labelledby');
    if (lb && lb.split(/\s+/).some((id) => document.getElementById(id))) return true;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return true;
    if (el.closest('label')) return true;
    const ti = el.getAttribute('title');
    if (ti && ti.trim()) return true;
    return false;
  };
  for (const el of walk('input, select, textarea')) {
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (!nameOf(el)) out.unlabelled.push({ tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', cls: String(el.className || '').slice(0, 80) });
  }
  for (const el of walk('button, a[href]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if ((el.innerText || el.textContent || '').trim()) continue;
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) continue;
    if (el.querySelector('svg title, svg[aria-label], img[alt]:not([alt=""])')) continue;
    out.namelessButtons.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 80), html: el.innerHTML.slice(0, 70) });
  }

  /* 8. heading order ------------------------------------------------------ */
  const hs = walk('h1,h2,h3,h4,h5,h6').filter((h) => {
    const r = h.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  out.headings = hs.map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || '').trim().slice(0, 50) }));
  let prev = 0;
  for (const h of out.headings) {
    if (prev && h.level > prev + 1) out.headingIssues.push('h' + prev + ' -> h' + h.level + ' at "' + h.text + '"');
    prev = h.level;
  }
  if (out.headings.length && out.headings[0].level !== 1) out.headingIssues.push('first heading is h' + out.headings[0].level + ', not h1');
  if (!out.headings.some((h) => h.level === 1)) out.headingIssues.push('no <h1> on the page');

  return out;
})()`;

/* Layout shift must be observing before navigation, so it is its own init script. */
const CLS_INIT = String.raw`(() => {
  window.__cls = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
})()`;

/**
 * Injected before every navigation so it survives client-side routing.
 *
 * Production never ships either of these, and when something trips the dev overlay it
 * covers the page completely — a screenshot of the overlay says nothing about the
 * product. Console errors are collected separately, so nothing is lost by hiding it.
 */
const HIDE_DEV_CHROME = String.raw`(() => {
  const css = 'nextjs-portal,[data-nextjs-toast],#__next-build-watcher{display:none !important}';
  const put = () => {
    if (!document.head || document.getElementById('__audit_hide')) return;
    const s = document.createElement('style');
    s.id = '__audit_hide';
    s.textContent = css;
    document.head.appendChild(s);
  };
  put();
  document.addEventListener('DOMContentLoaded', put);
})()`;

/* 9. focus visibility — tab through and check the focused element draws a ring. */
async function checkFocus(page: Page, ctx: Omit<Finding, 'check' | 'severity' | 'detail'>) {
  const bad: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      if (el.closest('nextjs-portal, [data-nextjs-toast]')) return { skip: true } as never;
      const cs = getComputedStyle(el);
      const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const hasShadow = cs.boxShadow !== 'none' && cs.boxShadow !== '';
      return {
        visible: hasOutline || hasShadow,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40),
        outline: cs.outlineStyle + ' ' + cs.outlineWidth,
      };
    });
    if (!r) break;
    if ((r as { skip?: boolean }).skip) continue;
    if (!r.visible) bad.push(`<${r.tag}> "${r.text}" (outline: ${r.outline})`);
  }
  if (bad.length) {
    add({
      ...ctx,
      check: 'focus-visible',
      severity: 'major',
      detail: `${bad.length} of the first 15 tab stops draw no focus ring: ${bad.slice(0, 4).join('; ')}`,
    });
  }
}

/* ------------------------------------------------------- palette probe -- */

/**
 * The palette, measured rather than trusted.
 *
 * `globals.css` documents a ratio beside almost every token ("verified against WCAG AA
 * by calculation"). Those comments were written while the light palette could not
 * compile — `@theme` nested in a media query is hoisted by Tailwind v4, so only the dark
 * values ever reached the browser — and so no light number in them was ever observed.
 * This resolves the tokens out of a real `:root` in a real browser and recomputes each
 * documented pair, which is the only way to tell a verified claim from a plausible one.
 */
const TOKEN_PAIRS: Array<{ fg: string; bg: string; use: string; large?: boolean }> = [
  { fg: 'ink', bg: 'surface', use: 'body text on a card' },
  { fg: 'ink', bg: 'paper', use: 'body text on the page ground' },
  { fg: 'muted', bg: 'surface', use: 'secondary text on a card' },
  { fg: 'muted', bg: 'paper', use: 'secondary text on the page ground' },
  { fg: 'brand', bg: 'surface', use: 'link/accent text on a card' },
  { fg: 'brand-dark', bg: 'surface', use: 'link text on a card' },
  { fg: 'brand-dark', bg: 'brand-tint', use: 'active nav item, category pill' },
  { fg: 'on-brand', bg: 'brand', use: 'primary button label' },
  { fg: 'on-brand', bg: 'brand-dark', use: 'primary button label, hover' },
  { fg: 'gold', bg: 'surface', use: 'interview count, accent stat' },
  { fg: 'gold', bg: 'gold-tint', use: 'gold badge' },
  { fg: 'gold-bright', bg: 'surface', use: 'decorative only — large text' , large: true },
  { fg: 'success', bg: 'surface', use: 'passing score, offer status' },
  { fg: 'success', bg: 'success-tint', use: 'success badge' },
  { fg: 'warning', bg: 'surface', use: 'below-threshold score' },
  { fg: 'warning', bg: 'warning-tint', use: 'warning badge' },
  { fg: 'danger', bg: 'surface', use: 'destructive action, error text' },
  { fg: 'danger', bg: 'danger-tint', use: 'error banner' },
  /* Non-text pairs, held to 1.4.11's 3:1 rather than 4.5:1. */
  { fg: 'muted', bg: 'surface', use: 'form control boundary (border-muted)', large: true },
  { fg: 'line', bg: 'surface', use: 'card edge — decorative, 3:1 not required', large: true },
  { fg: 'brand', bg: 'paper', use: 'focus ring against the page ground', large: true },
  { fg: 'brand', bg: 'surface', use: 'focus ring against a card', large: true },
];

const PALETTE_PROBE = String.raw`((pairs) => {
  const cs = getComputedStyle(document.documentElement);
  const canvas = document.createElement('canvas').getContext('2d');
  const rgb = (name) => {
    const raw = cs.getPropertyValue('--color-' + name).trim();
    if (!raw) return null;
    canvas.fillStyle = '#000';
    canvas.fillStyle = raw;
    const hex = canvas.fillStyle;
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { hex, r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  return pairs.map((p) => {
    const a = rgb(p.fg), b = rgb(p.bg);
    if (!a || !b) return { ...p, missing: true };
    const l1 = lum(a), l2 = lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return { ...p, ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100, fgHex: a.hex, bgHex: b.hex };
  });
})`;

async function probePalette(browser: Browser, scheme: 'light' | 'dark') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle', timeout: 60_000 });
  const rows = (await page.evaluate(PALETTE_PROBE as unknown as string, TOKEN_PAIRS)) as Array<{
    fg: string; bg: string; use: string; large?: boolean; missing?: boolean;
    ratio?: number; fgHex?: string; bgHex?: string;
  }>;
  for (const row of rows) {
    const base = { page: 'palette', viewport: '(tokens)', scheme } as const;
    if (row.missing) {
      add({ ...base, check: 'palette', severity: 'major', detail: `--color-${row.fg} or --color-${row.bg} does not resolve` });
      continue;
    }
    const need = row.large ? 3 : 4.5;
    const ratio = row.ratio ?? 0;
    if (ratio < need - 0.005) {
      add({
        ...base,
        check: 'palette',
        severity: ratio < need * 0.7 ? 'major' : 'minor',
        detail: `${row.ratio}:1 (needs ${need}:1) — text-${row.fg} ${row.fgHex} on bg-${row.bg} ${row.bgHex} — ${row.use}`,
      });
    } else {
      add({ ...base, check: 'palette-ok', severity: 'info', detail: `${row.ratio}:1 — text-${row.fg} ${row.fgHex} on bg-${row.bg} ${row.bgHex} — ${row.use}` });
    }
  }
  await ctx.close();
}

/* ------------------------------------------------------------------- seed -- */

const TEST_EMAIL = `zz-uiaudit-${Date.now()}@example.invalid`;
const TEST_PASSWORD = 'a-long-enough-audit-passphrase-9';
let sql: ReturnType<typeof postgres> | null = null;
let seededId: string | null = null;

/**
 * The seeded resume snapshot, shared by /applications and /resume/[snapshotId].
 *
 * Both screens need one and it must be the same row: an application references a
 * snapshot, and auditing the resume page means opening the very snapshot those
 * applications point at.
 */
let seededSnapshotId: string | null = null;

async function seedUser() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  sql = postgres(process.env.DATABASE_URL, { max: 1 });
  seededId = randomUUID();

  /**
   * Re-running the audit signs in again from the same address, and the sign-in limiter
   * counts by caller IP as well as by email. After a few runs the loopback IP is over
   * its threshold and every subsequent sign-in is refused — which looked like a broken
   * harness rather than a working rate limiter. Clearing the loopback subject keeps the
   * script re-runnable; it touches only rows this machine created.
   */
  await sql`
    delete from auth_attempt
    where action = 'sign-in'
      and (subject like 'ip:127.0.0.1%' or subject like 'ip:::1%' or subject like 'email:zz-uiaudit-%')`;

  const hash = await hashPassword(TEST_PASSWORD);
  await sql`
    insert into "user" (id, name, email, "emailVerified", password_hash, created_at)
    values (${seededId}, ${'UI Audit'}, ${TEST_EMAIL}, now(), ${hash}, now())`;

  if (!has('empty-profile')) await seedRecords(sql);
  console.log(`seeded ${TEST_EMAIL}${has('empty-profile') ? ' (empty profile)' : ' with sample records'}`);
}

/**
 * A handful of synthetic records, because /profile hides every section — and therefore
 * every form, chip and row the page is made of — while the profile is empty. Auditing
 * only the empty state would leave the densest screen in the app unmeasured.
 *
 * Deliberately includes a long skill name and a long bullet: overflow and clipping show
 * up on the awkward values, not the tidy ones. Everything is invented; nothing here
 * comes from a real profile. It is removed with the user by the cascade on user_id.
 */
async function seedRecords(q: NonNullable<typeof sql>) {
  const roleId = randomUUID();
  await q`
    insert into role (id, user_id, title, company, location, start_date, end_date, source, content_hash)
    values (${roleId}, ${seededId}, ${'Senior Platform Engineer'}, ${'Northwind Analytics'},
            ${'Chennai, India'}, ${'2021-03'}, ${'present'}, ${'manual'}, ${'audit-role-1'})`;

  const records: Array<[string, Record<string, unknown>]> = [
    ['summary', { text: 'Platform engineer with eight years building data infrastructure that other teams depend on.' }],
    ['skill', { name: 'TypeScript' }],
    ['skill', { name: 'PostgreSQL' }],
    ['skill', { name: 'Kubernetes' }],
    ['skill', { name: 'Distributed Systems Observability and Tracing' }],
    ['project', { name: 'Tidewater', description: 'An internal metrics pipeline that replaced three cron jobs and a spreadsheet.', url: 'https://example.com/tidewater' }],
    ['education', { degree: 'B.E. Computer Science', institution: 'Anna University', endDate: '2017' }],
    ['certification', { name: 'AWS Solutions Architect — Associate', issuer: 'Amazon Web Services', date: '2023' }],
    ['language', { name: 'Tamil' }],
    ['language', { name: 'English' }],
    ['interest', { name: 'Long-distance cycling' }],
    ['experience-bullet', {
      roleId,
      action: 'Rebuilt the ingestion path so a failed batch retries from its last good offset instead of the beginning',
      scale: 'across 40 million rows a day',
      outcome: 'cutting median recovery time from four hours to eleven minutes',
      text: 'Rebuilt the ingestion path so a failed batch retries from its last good offset instead of the beginning, across 40 million rows a day, cutting median recovery time from four hours to eleven minutes.',
    }],
  ];

  for (const [type, data] of records) {
    // Cast the JSON on the server rather than relying on the driver's inference: the
    // column is jsonb and a bare string parameter lands in it as a quoted string.
    await q`
      insert into profile_record (id, user_id, type, source, content_hash, tags, data)
      values (${randomUUID()}, ${seededId}, ${type}, ${'manual'},
              ${`audit-${type}-${Math.random().toString(36).slice(2, 10)}`},
              ${'[]'}::jsonb, ${JSON.stringify(data)}::jsonb)`;
  }
}

/**
 * One resume snapshot and the applications that point at it.
 *
 * `/applications` and `/resume/[snapshotId]` have never been audited with content in
 * them — the table is six columns inside an `overflow-x-auto`, which is exactly the
 * shape that goes wrong at 320px, and the editor is a long list of grouped line items.
 * The statuses below cover every branch of `StatusSelect`'s TONE map and both sides of
 * the 8.5 score threshold, so each colour the page can produce is actually rendered.
 *
 * Everything is written against the seeded user id and removed with it.
 */
async function seedApplications(q: NonNullable<typeof sql>) {
  seededSnapshotId = randomUUID();

  const item = (text: string) => ({ text, sourceRecordId: null });
  const document = {
    id: seededSnapshotId,
    userId: seededId,
    contact: {
      fullName: 'Uma Iyer',
      email: 'uma.iyer@example.invalid',
      phone: '+91 90000 00000',
      location: 'Chennai, India',
      portfolioUrl: 'https://example.invalid/uma',
      githubUrl: 'https://github.com/example',
      linkedinUrl: 'https://www.linkedin.com/in/example',
    },
    sections: [
      {
        key: 'summary',
        heading: 'Summary',
        items: [
          item(
            'Platform engineer with eight years on data infrastructure other teams depend on, most recently owning an ingestion path that moves 40 million rows a day.',
          ),
        ],
      },
      {
        key: 'skills',
        heading: 'Skills',
        items: [
          item('Languages: TypeScript, Python, Go, SQL'),
          item('Infrastructure: PostgreSQL, Kubernetes, Terraform, Kafka'),
          item('Practice: distributed tracing, incident review, capacity planning'),
        ],
      },
      {
        key: 'experience',
        heading: 'Experience',
        items: [],
        groups: [
          {
            title: 'Senior Platform Engineer',
            subtitle: 'Northwind Analytics — Chennai, India',
            dateRange: '2021-03 – present',
            items: [
              item(
                'Rebuilt the ingestion path so a failed batch retries from its last good offset instead of the beginning, across 40 million rows a day, cutting median recovery time from four hours to eleven minutes.',
              ),
              item(
                'Introduced per-tenant rate limits at the edge, which removed the weekly on-call page for noisy-neighbour saturation entirely.',
              ),
              item(
                'Moved the metrics pipeline off three cron jobs and a spreadsheet onto a scheduled DAG, reducing month-end reporting from two days to under an hour.',
              ),
            ],
          },
          {
            title: 'Platform Engineer',
            subtitle: 'Kestrel Systems — Bengaluru, India',
            dateRange: '2018-06 – 2021-02',
            items: [
              item(
                'Cut p99 checkout latency from 1.8s to 420ms by replacing a synchronous fan-out with a materialised read model.',
              ),
              item(
                'Wrote the migration tooling that moved 140 services from hand-rolled deploy scripts onto a single pipeline.',
              ),
            ],
          },
        ],
      },
      {
        key: 'projects',
        heading: 'Projects',
        items: [],
        groups: [
          {
            title: 'Tidewater',
            subtitle: 'Internal metrics pipeline',
            items: [
              item('Replaced three cron jobs and a spreadsheet with a scheduled pipeline other teams now build on.'),
            ],
          },
        ],
      },
      {
        key: 'education',
        heading: 'Education',
        items: [item('B.E. Computer Science, Anna University, 2017')],
      },
      {
        key: 'certifications',
        heading: 'Certifications',
        items: [item('AWS Solutions Architect — Associate, Amazon Web Services, 2023')],
      },
    ],
    jobRequirement: {
      title: 'Staff Platform Engineer',
      company: 'Meridian Data',
      mustHave: ['PostgreSQL', 'Kubernetes', 'Kafka'],
      niceToHave: ['Terraform', 'Go'],
      keywords: ['ingestion', 'observability', 'reliability'],
    },
    renderMode: 'ats-strict',
    recordHashSnapshot: [],
    createdAt: new Date().toISOString(),
  };

  const scoreDetail = {
    keywordGatePassed: true,
    keywordCoveragePct: 82,
    missingKeywords: ['Terraform'],
    formattingScore: 0.95,
    evidenceScore: 0.88,
    skillsCompletenessScore: 0.8,
    overall: 8.7,
    passed: true,
    iterations: 2,
    critiques: [
      { subScore: 'skills', message: 'Terraform appears in the posting but nowhere in the profile.' },
      { subScore: 'evidence', message: 'Two bullets state an action without a measured outcome.' },
    ],
  };

  await q`
    insert into resume_snapshot (id, user_id, document, job_requirement, score, score_detail, record_hash_snapshot, render_mode, file_name, created_at)
    values (${seededSnapshotId}, ${seededId}, ${JSON.stringify(document)}::jsonb,
            ${JSON.stringify(document.jobRequirement)}::jsonb, ${8.7},
            ${JSON.stringify(scoreDetail)}::jsonb, ${'[]'}::jsonb, ${'ats-strict'},
            ${'uma-iyer-staff-platform-engineer.pdf'}, now())`;

  const apps: Array<[string, string, string, string, number | null]> = [
    ['Staff Platform Engineer', 'Meridian Data', 'platform', 'interview', 8.7],
    ['Senior Backend Engineer, Payments and Settlement Infrastructure', 'Longbow Financial Technologies', 'backend', 'applied', 7.4],
    ['Infrastructure Engineer', 'Harbourline', 'infrastructure', 'offer', 9.1],
    ['Data Platform Engineer', 'Alcove', 'data', 'rejected', 6.2],
    ['Site Reliability Engineer', 'Vantage Grid', 'general', 'draft', null],
  ];
  for (const [roleTitle, company, category, status, score] of apps) {
    await q`
      insert into application (id, user_id, resume_snapshot_id, role_title, company, category, score, status, created_at, updated_at)
      values (${randomUUID()}, ${seededId}, ${seededSnapshotId}, ${roleTitle}, ${company},
              ${category}, ${score}, ${status}, now(), now())`;
  }
}

/**
 * A LinkedIn export archive, built here rather than uploaded by hand.
 *
 * `/import`'s review step is the densest screen in the application and the only route to
 * it is a real upload. The resume route needs a model per chunk, which makes it slow and
 * non-deterministic; the LinkedIn route is pure CSV parsing, so an archive assembled in
 * memory reaches the same review screen every single time.
 *
 * Written as a stored (uncompressed) ZIP because `lib/import/zip.ts` accepts method 0,
 * which removes the need for a packaging dependency for the sake of a fixture.
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function storedZip(files: Array<[string, string]>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10); // stored
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

function linkedInFixture(): Buffer {
  return storedZip([
    [
      'Profile.csv',
      'First Name,Last Name,Headline,Summary,Geo Location,Websites\n' +
        `Uma,Iyer,${q('Platform engineer')},${q('Platform engineer with eight years on data infrastructure other teams depend on. I like the unglamorous half of the job: the retry path, the backfill, the runbook nobody has had to open in a year.')},${q('Chennai, Tamil Nadu, India')},${q('[STANDARD:https://example.invalid/uma]')}\n`,
    ],
    [
      'Positions.csv',
      'Company Name,Title,Description,Location,Started On,Finished On\n' +
        `${q('Northwind Analytics')},${q('Senior Platform Engineer')},${q('Rebuilt the ingestion path so a failed batch retries from its last good offset instead of the beginning, cutting median recovery time from four hours to eleven minutes.\nIntroduced per-tenant rate limits at the edge, removing the weekly on-call page for noisy-neighbour saturation.\nMoved month-end reporting off three cron jobs and a spreadsheet onto a scheduled pipeline.')},${q('Chennai, India')},${q('Mar 2021')},\n` +
        `${q('Kestrel Systems')},${q('Platform Engineer')},${q('Cut p99 checkout latency from 1.8s to 420ms by replacing a synchronous fan-out with a materialised read model.\nWrote the migration tooling that moved 140 services onto a single deploy pipeline.')},${q('Bengaluru, India')},${q('Jun 2018')},${q('Feb 2021')}\n` +
        `${q('Kestrel Systems')},${q('Platform Engineer')},${q('Ran the on-call rotation review that halved repeat incidents quarter over quarter.')},${q('Bengaluru, India')},${q('Jun 2018')},${q('Feb 2021')}\n` +
        `${q('Alcove')},${q('Junior Engineer')},,${q('Remote')},${q('Aug 2017')},${q('May 2018')}\n`,
    ],
    [
      'Skills.csv',
      'Name\nTypeScript\nPostgreSQL\nKubernetes\nDistributed Systems Observability and Tracing\nTerraform\nApache Kafka\nGo\nIncident Response\n',
    ],
    [
      'Education.csv',
      'School Name,Degree Name,Field Of Study,Start Date,End Date\n' +
        `${q('Anna University')},${q('B.E.')},${q('Computer Science')},2013,2017\n`,
    ],
    [
      'Certifications.csv',
      'Name,Authority,Started On,Url\n' +
        `${q('AWS Solutions Architect — Associate')},${q('Amazon Web Services')},${q('Feb 2023')},${q('https://example.invalid/cert')}\n`,
    ],
    ['Languages.csv', 'Name,Proficiency\nTamil,Native or bilingual proficiency\nEnglish,Full professional proficiency\n'],
    [
      'Projects.csv',
      'Title,Description,Url\n' +
        `${q('Tidewater')},${q('An internal metrics pipeline that replaced three cron jobs and a spreadsheet, now used by four teams.')},${q('https://example.invalid/tidewater')}\n`,
    ],
    [
      'Honors.csv',
      'Title,Description,Issued On\n' +
        `${q('Engineering Excellence Award')},${q('For the ingestion rewrite.')},${q('Dec 2022')}\n`,
    ],
    ['Email Addresses.csv', 'Email Address,Confirmed,Primary\numa.iyer@example.invalid,Yes,Yes\n'],
    ['Interests.csv', 'Name\nLong-distance cycling\n'],
  ]);
}

async function removeUser() {
  if (!sql || !seededId || has('keep-user')) return;
  await sql`delete from "user" where id = ${seededId}`;
  console.log('removed the seeded user');
}

async function signIn(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill(TEST_EMAIL);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);

  /**
   * Wait for hydration before clicking, and use the form's own state to detect it.
   *
   * The submit button is disabled until React has seen both fields, so it going enabled
   * proves the handlers are attached. Clicking sooner fires a native submit that does
   * nothing and reports nothing — which is what an intermittently failing sign-in
   * looked like from the outside.
   */
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  await submit.waitFor({ state: 'visible', timeout: 20_000 });
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('button[type="submit"]')].some(
          (b) => (b.textContent || '').trim() === 'Sign in' && !(b as HTMLButtonElement).disabled,
        ),
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => {});
  await submit.click();
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // The form reports every failure in a role=status paragraph. Surfacing it turns an
  // opaque "auth failed" into the actual reason (wrong password, unconfirmed, throttled).
  const onPage = (await page.locator('[role="status"]').allInnerTexts()).join(' ').trim();

  await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/sign-in')) {
    throw new Error(
      `sign-in did not take — /profile still redirects to /sign-in${onPage ? `. The form said: "${onPage}"` : ' (the form reported nothing)'}`,
    );
  }
  await page.close();
  return ctx;
}

/* ------------------------------------------------------------------- run -- */

const dedupe = (xs: string[]) => [...new Set(xs)];

const sha = (buf: Buffer) => createHash('sha1').update(buf).digest('hex');

/** target|viewport|scheme -> screenshot hash, for the theme check below. */
const shotHashes = new Map<string, string>();

/**
 * One blocked font family produces a dozen identical violations — one per weight, times
 * woff2/woff/ttf. Collapsing on (directive, host) turns that back into the one fact it
 * actually is, with a count so the scale is not lost.
 */
function collapseByHost(messages: string[], label: string): string[] {
  const groups = new Map<string, { n: number; sample: string }>();
  for (const m of messages) {
    const host = m.match(/https?:\/\/([^/'" ]+)/)?.[1] ?? '(no host)';
    const directive = m.match(/directive: "([a-z-]+)/)?.[1] ?? label;
    const key = `${directive}|${host}`;
    const g = groups.get(key) ?? { n: 0, sample: m };
    g.n++;
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => {
    const [directive, host] = key.split('|');
    return g.n > 1
      ? `${g.n}x blocked by ${directive} from ${host} — e.g. ${g.sample.slice(0, 150)}`
      : g.sample;
  });
}

/** The Next.js dev-mode error overlay is tooling, not the product. */
const isDevOverlay = (cls: string, tag: string) =>
  tag === 'nextjs-portal' || /nextjs-portal|__next-dev|nextjs__container/.test(cls);

/** One measured element, as the in-page script serialised it. */
type Measured = Record<string, string | number | boolean | null | undefined>;

interface InPageResult {
  overflow: { scrollWidth: number; viewport: number } | null;
  wide: Measured[];
  touch: Measured[];
  clipped: Measured[];
  squeezed: Measured[];
  contrast: Measured[];
  alt: Measured[];
  unlabelled: Measured[];
  namelessButtons: Measured[];
  headings: Measured[];
  headingIssues: string[];
  [key: string]: unknown;
}

async function capture(
  browser: Browser,
  authState: unknown | null,
  target: Target,
  vp: (typeof VIEWPORTS)[number],
  scheme: 'light' | 'dark',
) {
  const signedOut = target.auth && !authState;
  const slug = scheme === 'dark' ? `${target.slug}-dark` : target.slug;
  const ctxOpts: Record<string, unknown> = {
    viewport: { width: vp.width, height: vp.height },
    colorScheme: scheme,
    deviceScaleFactor: 1,
    isMobile: vp.phone,
    hasTouch: vp.phone,
  };
  if (authState) ctxOpts.storageState = authState;
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();

  const base = { page: slug, viewport: vp.name, scheme } as const;

  /* 5 + 6. console, page errors, CSP, failed requests */
  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  const failed: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    const bucket = /Content Security Policy|Refused to (load|apply|execute|connect)/i.test(t)
      ? cspViolations
      : consoleErrors;
    bucket.push(t.slice(0, 220));
  });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e.message).slice(0, 220)));
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 130)}`);
  });
  page.on('requestfailed', (r) => {
    failed.push(`BLOCKED/FAILED ${r.url().slice(0, 130)} (${r.failure()?.errorText ?? '?'})`);
  });

  await page.addInitScript(CLS_INIT);

  /**
   * The Next dev-mode error overlay and its toast render on top of the page and, when
   * something trips them, cover it completely — a screenshot of the overlay tells you
   * nothing about the product, which in production never ships it. Console errors are
   * collected above regardless, so nothing is lost by keeping it out of the picture.
   */
  await page.addInitScript(HIDE_DEV_CHROME);

  let landedOn = '';
  try {
    await page.goto(BASE + target.url, { waitUntil: 'networkidle', timeout: 60_000 });
    landedOn = new URL(page.url()).pathname;
    if (target.setup) {
      await target.setup(page).catch((e) =>
        add({ ...base, check: 'setup', severity: 'info', detail: `state setup failed: ${String(e).slice(0, 120)}` }),
      );
    }
    // Web fonts settle after networkidle; screenshotting sooner captures the fallback.
    await page.evaluate(() => (document as Document).fonts?.ready).catch(() => {});
    await page.waitForTimeout(400);
  } catch (e) {
    add({ ...base, check: 'load', severity: 'blocker', detail: `navigation failed: ${String(e).slice(0, 160)}` });
    await ctx.close();
    return;
  }

  const dir = path.join(OUT, slug);
  await mkdir(dir, { recursive: true });
  const shotPath = path.join(dir, `${vp.name}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  shotHashes.set(`${target.slug}|${vp.name}|${scheme}`, sha(await readFile(shotPath)));

  if (signedOut && !landedOn.startsWith(target.url.split('?')[0])) {
    add({
      ...base,
      check: 'auth',
      severity: 'info',
      detail: `signed out: redirected to ${landedOn} — this capture is the sign-in page, not ${target.url}`,
    });
  }

  /**
   * Everything crossing the browser boundary arrives as plain JSON, so it is typed as
   * records of primitives rather than `any` — permissive about which keys each check
   * contributes, strict about the fact that none of them are objects or functions.
   */
  const r = (await page.evaluate(IN_PAGE)) as InPageResult;

  if (r.overflow) {
    const worst = r.wide
      .slice(0, 3)
      .map((w: Measured) => `<${w.tag} class="${w.cls}"> right=${w.right} w=${w.width}${w.text ? ` "${w.text}"` : ''}`);
    add({
      ...base,
      check: 'h-overflow',
      severity: vp.width <= 375 ? 'blocker' : 'major',
      detail: `scrollWidth ${r.overflow.scrollWidth} vs viewport ${r.overflow.viewport} (+${r.overflow.scrollWidth - r.overflow.viewport}px). Widest: ${worst.join(' | ')}`,
    });
  }

  if (vp.phone && r.touch.length) {
    const list = r.touch
      .slice(0, 6)
      .map((t: Measured) => `<${t.tag}${t.type ? ' ' + t.type : ''}> ${t.w}x${t.h}${t.text ? ` "${t.text}"` : ''}`);
    add({ ...base, check: 'touch-target', severity: 'minor', detail: `${r.touch.length} control(s) under 44px: ${list.join(' | ')}` });
  }

  if (r.clipped.length) {
    add({
      ...base,
      check: 'text-clipped',
      severity: 'major',
      detail: r.clipped
        .slice(0, 4)
        .map((c: Measured) => `${c.axis}: "${c.text}" ${c.scroll}>${c.client} (.${String(c.cls ?? '').split(' ')[0]})`)
        .join(' | '),
    });
  }

  if (r.squeezed.length) {
    add({
      ...base,
      check: 'text-squeezed',
      severity: 'major',
      detail: `${r.squeezed.length} text block(s) wrapped into a narrow ribbon: ${r.squeezed
        .slice(0, 4)
        .map((q: Measured) => `<${q.tag}> ${q.w}px wide (~${q.perLine} chars) over ${q.lines} lines inside a ${q.parentW}px parent — "${q.text}"`)
        .join(' | ')}`,
    });
  }

  for (const c of r.contrast.slice(0, 40)) {
    add({
      ...base,
      check: 'contrast',
      severity: Number(c.ratio ?? 0) < 3 ? 'major' : 'minor',
      detail: `${c.ratio}:1 (needs ${c.need}:1) — ${c.fg} on ${c.bg}, ${c.px}px/${c.weight} — "${c.text}" [${String(c.cls ?? '').split(' ').slice(0, 3).join(' ')}]`,
    });
  }

  if (r.alt.length) {
    add({ ...base, check: 'img-alt', severity: 'major', detail: `${r.alt.length} <img> without alt: ${r.alt.map((a: Measured) => a.src).join(', ')}` });
  }
  if (r.unlabelled.length) {
    add({
      ...base,
      check: 'input-name',
      severity: 'major',
      detail: `${r.unlabelled.length} form control(s) with no accessible name: ${r.unlabelled.slice(0, 5).map((u: Measured) => `<${u.tag} ${u.type} name=${u.name || '?'} class="${u.cls}">`).join(', ')}`,
    });
  }
  if (r.namelessButtons.length) {
    add({
      ...base,
      check: 'button-name',
      severity: 'major',
      detail: `${r.namelessButtons.length} button/link with no text: ${r.namelessButtons.slice(0, 4).map((b: Measured) => `<${b.tag}> ${b.html}`).join(' | ')}`,
    });
  }
  for (const h of r.headingIssues) add({ ...base, check: 'heading-order', severity: 'minor', detail: h });

  await checkFocus(page, base);

  const cls = (await page.evaluate('window.__cls')) as number;
  if (typeof cls === 'number' && cls > 0.1) {
    add({ ...base, check: 'layout-shift', severity: cls > 0.25 ? 'major' : 'minor', detail: `cumulative layout shift ${cls.toFixed(3)} (good is < 0.1)` });
  }

  for (const v of collapseByHost(dedupe(cspViolations), 'csp')) {
    add({ ...base, check: 'csp', severity: 'major', detail: v });
  }
  for (const e of dedupe(consoleErrors)) {
    // React's dev build wants eval() and says so on every page; it never does this in a
    // production build, so it is a note about the dev CSP, not a bug in the app.
    const devOnly = /React requires eval\(\) in development mode/.test(e);
    add({ ...base, check: 'console-error', severity: devOnly ? 'info' : 'major', detail: e });
  }
  for (const f of collapseByHost(dedupe(failed), 'network')) {
    add({ ...base, check: 'network', severity: /BLOCKED/.test(f) ? 'major' : 'minor', detail: f });
  }

  await ctx.close();
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let authState: unknown | null = null;
  if (!has('no-auth')) {
    try {
      await seedUser();
      const b0 = await chromium.launch();
      const ctx = await signIn(b0);
      authState = await ctx.storageState();
      await ctx.close();
      await b0.close();
      console.log('signed in as the seeded user');
    } catch (e) {
      console.error('AUTH SETUP FAILED — signed-out captures only:', String(e).slice(0, 300));
      authState = null;
    }
  }

  const targets = TARGETS.filter((t) => !PAGE_FILTER || PAGE_FILTER.some((f) => t.slug.includes(f)));
  const viewports = VIEWPORTS.filter((v) => !VIEW_FILTER || VIEW_FILTER.includes(v.name));

  const browser = await chromium.launch();
  for (const t of targets) {
    for (const v of viewports) {
      process.stdout.write(`  ${t.slug} @ ${v.name} … `);
      await capture(browser, authState, t, v, 'light');
      if (DARK_VIEWPORTS.has(v.name)) await capture(browser, authState, t, v, 'dark');
      console.log('ok');
    }
  }
  await browser.close();

  /**
   * A page whose light and dark captures are byte-identical is not honouring
   * `prefers-color-scheme` at all. That is invisible in any single screenshot and is
   * exactly the kind of thing a palette can regress into silently, so it is asserted
   * rather than left to whoever is reading the PNGs.
   */
  for (const t of targets) {
    for (const v of viewports) {
      if (!DARK_VIEWPORTS.has(v.name)) continue;
      const light = shotHashes.get(`${t.slug}|${v.name}|light`);
      const dark = shotHashes.get(`${t.slug}|${v.name}|dark`);
      if (light && dark && light === dark) {
        add({
          page: t.slug,
          viewport: v.name,
          scheme: 'light',
          check: 'color-scheme',
          severity: 'blocker',
          detail:
            'the light and dark captures are byte-identical — prefers-color-scheme changes nothing, so one palette is being served to every user',
        });
      }
    }
  }

  /* ------------------------------------------------------------- report -- */
  const order: Severity[] = ['blocker', 'major', 'minor', 'info'];
  findings.sort(
    (a, b) =>
      order.indexOf(a.severity) - order.indexOf(b.severity) ||
      a.check.localeCompare(b.check) ||
      a.page.localeCompare(b.page),
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    authenticated: Boolean(authState),
    pages: targets.map((t) => t.slug),
    viewports: viewports.map((v) => v.name),
    counts: Object.fromEntries(order.map((s) => [s, findings.filter((f) => f.severity === s).length])),
    byCheck: Object.fromEntries(
      [...new Set(findings.map((f) => f.check))].map((c) => [c, findings.filter((f) => f.check === c).length]),
    ),
    findings,
  };
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));

  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  console.log('\n' + '='.repeat(120));
  console.log(`${findings.length} finding(s)  ·  ` + order.map((s) => `${s}: ${summary.counts[s]}`).join('  '));
  console.log('='.repeat(120));
  console.log(pad('SEV', 9) + pad('PAGE', 24) + pad('VIEWPORT', 13) + pad('CHECK', 15) + 'DETAIL');
  console.log('-'.repeat(120));
  for (const f of findings) {
    console.log(pad(f.severity, 9) + pad(f.page, 24) + pad(f.viewport, 13) + pad(f.check, 15) + f.detail.slice(0, 300));
  }
  console.log('\nscreenshots/report.json written · PNGs under screenshots/<page>/<viewport>.png');

  await removeUser();
  await sql?.end();
}

main().catch(async (e) => {
  console.error(e);
  await removeUser();
  await sql?.end();
  process.exit(1);
});
