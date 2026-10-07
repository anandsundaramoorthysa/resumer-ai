/** app/sitemap.ts is stable across calls and lists the six public paths; maintenance banner copy helper. */

import { suite, test, assert } from './harness.mjs';
import * as sitemapMod from '../app/sitemap';
// tsx may wrap the default export once more under CJS interop.
const d = (sitemapMod as unknown as { default: unknown }).default;
const sitemap = (typeof d === 'function' ? d : (d as { default: () => ReturnType<typeof import('../app/sitemap').default> }).default) as typeof import('../app/sitemap').default;
import { formatMaintenance, MAINTENANCE_MAX } from '../components/maintenance-text';

suite('sitemap', () => {
  test('stable lastModified across calls', () => {
    const a = JSON.stringify(sitemap());
    const b = JSON.stringify(sitemap());
    assert(a === b, 'two calls identical');
  });

  test('includes the six public paths', () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname.replace(/\/$/, '') || '/');
    for (const p of ['/', '/sign-in', '/privacy', '/terms', '/contact', '/accessibility']) {
      assert(paths.includes(p), `missing ${p}`);
    }
  });
});

suite('maintenance banner text', () => {
  test('empty/blank renders nothing', () => {
    assert(formatMaintenance('') === null, 'empty');
    assert(formatMaintenance('  \n ') === null, 'blank');
    assert(formatMaintenance(undefined) === null, 'undefined');
  });

  test('collapses whitespace and caps length', () => {
    assert(formatMaintenance(' a \n b ') === 'a b', 'collapse');
    const out = formatMaintenance('x'.repeat(500)) as string;
    assert(out.length === MAINTENANCE_MAX && out.endsWith('…'), 'capped at 300 with ellipsis');
  });
});
