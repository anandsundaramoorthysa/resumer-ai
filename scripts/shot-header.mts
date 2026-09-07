/**
 * Screenshots the shared header across viewports, signed in.
 *
 * Narrow in scope on purpose: the full UI audit lives in scripts/ui-audit.mts. This one
 * exists to look at the navigation itself, which is the thing that was broken — six pages
 * with six different navs, no sign-out anywhere, and a resume page with no way back.
 *
 * It signs in through the real form rather than forging a cookie, because the header only
 * renders for a signed-in user and a forged session would not exercise the same path.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import postgres from 'postgres';
import { chromium, devices } from '@playwright/test';
import { hashPassword } from '../lib/auth/password';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:3000';
const EMAIL = `zzshot-${Date.now()}@example.invalid`;
const PASSWORD = 'harbour wall mist 2026';
const OUT = 'screenshots/header';

const VIEWPORTS: Array<[string, number, number]> = [
  ['320-phone-small', 320, 568],
  ['375-phone', 375, 812],
  ['414-phone-large', 414, 896],
  ['768-tablet', 768, 1024],
  ['1280-laptop', 1280, 800],
  ['1440-desktop', 1440, 900],
];

const PAGES: Array<[string, string]> = [
  ['dashboard', '/'],
  ['profile', '/profile'],
  ['import', '/import'],
  ['portfolio', '/settings/portfolio'],
  ['applications', '/applications'],
  ['answers', '/settings/application'],
];

/** The sign-in page has no app header, so it waits for the form instead. */
async function gotoWithHeader2(page: import('@playwright/test').Page, url: string) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForSelector('input[type="email"]', { timeout: 20_000 });
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await page.waitForTimeout(3000);
    }
  }
}

/** Navigates, and waits for the header — retrying through a dev-server rebuild. */
async function gotoWithHeader(page: import('@playwright/test').Page, url: string) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page.waitForSelector('header', { state: 'attached', timeout: 20_000 });
      return;
    } catch (err) {
      if (attempt === 4) throw err;
      await page.waitForTimeout(3000);
    }
  }
}

/**
 * Signs in with the email/password form specifically.
 *
 * The sign-in page has three things that answer to "sign in": the GitHub button (its own
 * form, and FIRST in the document), the mode tab, and the actual submit button. Targeting
 * `form button[type="submit"]` picked the GitHub one and walked off to github.com. The
 * form is identified by the field only it has.
 */
async function signInWithPassword(page: import('@playwright/test').Page) {
  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"]').fill(EMAIL);
  await form.locator('input[type="password"]').fill(PASSWORD);
  await form.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 30_000 });
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

await sql`delete from "user" where email = ${EMAIL}`;
await sql`insert into "user" (id, email, name, password_hash, "emailVerified")
          values (${randomUUID()}, ${EMAIL}, 'Screenshot Tester', ${await hashPassword(PASSWORD)}, now())`;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const problems: string[] = [];

try {
  for (const [label, width, height] of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      userAgent: width < 500 ? devices['iPhone 13'].userAgent : undefined,
    });
    const page = await context.newPage();

    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`[console ${label}] ${m.text().slice(0, 160)}`);
    });

    // Sign in once per context.
    await gotoWithHeader2(page, `${BASE}/sign-in`);
    await signInWithPassword(page);

    for (const [name, path] of PAGES) {
      // Retried because a dev server shared with another process restarts on file
      // changes, and a navigation that lands mid-rebuild simply never settles.
      await gotoWithHeader(page, `${BASE}${path}`);

      // The check that matters most on a phone: does the page scroll sideways?
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        if (doc.scrollWidth <= window.innerWidth) return null;
        const wide = [...document.querySelectorAll('*')]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(0, 3)
          .map((el) => `${el.tagName.toLowerCase()}.${(el.className || '').toString().slice(0, 60)}`);
        return { scrollWidth: doc.scrollWidth, viewport: window.innerWidth, wide };
      });
      if (overflow) {
        problems.push(
          `[overflow ${label} ${name}] ${overflow.scrollWidth}px in a ${overflow.viewport}px viewport — ${overflow.wide.join(' | ')}`,
        );
      }

      // Every nav link and the sign-out button must be present and large enough to tap.
      const nav = await page.evaluate(() => {
        const links = [...document.querySelectorAll('nav[aria-label="Main"] a')].map((a) => ({
          label: (a.textContent ?? '').trim(),
          height: Math.round(a.getBoundingClientRect().height),
          visible: a.getBoundingClientRect().height > 0,
          current: a.getAttribute('aria-current') === 'page',
        }));
        const signOut = [...document.querySelectorAll('button')].find(
          (b) => (b.textContent ?? '').trim().toLowerCase() === 'sign out',
        );
        return {
          links,
          signOut: signOut
            ? { height: Math.round(signOut.getBoundingClientRect().height) }
            : null,
        };
      });

      if (nav.links.length !== PAGES.length) {
        problems.push(`[nav ${label} ${name}] expected ${PAGES.length} links, found ${nav.links.length}`);
      }
      if (!nav.signOut) problems.push(`[nav ${label} ${name}] no sign-out button`);
      for (const l of nav.links) {
        if (!l.visible) problems.push(`[nav ${label} ${name}] "${l.label}" is not visible`);
        if (width < 500 && l.height < 44) {
          problems.push(`[touch ${label} ${name}] "${l.label}" is ${l.height}px tall, under 44`);
        }
      }
      if (nav.signOut && width < 500 && nav.signOut.height < 44) {
        problems.push(`[touch ${label} ${name}] sign out is ${nav.signOut.height}px tall`);
      }
      if (!nav.links.some((l) => l.current)) {
        problems.push(`[nav ${label} ${name}] no link marked as the current page`);
      }

      // Just the header, cropped — the whole page is the other script's job.
      const header = page.locator('header').first();
      await header.screenshot({ path: `${OUT}/${name}-${label}.png` });
    }

    await context.close();
  }

  // And that sign-out actually signs you out.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await gotoWithHeader2(page, `${BASE}/sign-in`);
  await signInWithPassword(page);

  await page.getByRole('button', { name: /sign out/i }).click();
  await page.waitForURL(/\/sign-in/, { timeout: 20_000 });

  await page.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
  const landed = new URL(page.url()).pathname;
  if (!landed.startsWith('/sign-in')) {
    problems.push(`[sign-out] still signed in — /profile served ${landed}`);
  } else {
    console.log('ok   sign out works, and /profile then redirects to sign-in');
  }
  await context.close();
} finally {
  await browser.close();
  await sql`delete from "user" where email = ${EMAIL}`;
  await sql.end();
}

console.log(`\nscreenshots in ${OUT}/`);
if (problems.length === 0) {
  console.log('no problems detected');
} else {
  console.log(`\n${problems.length} problems:`);
  for (const p of [...new Set(problems)]) console.log('  ' + p);
}
