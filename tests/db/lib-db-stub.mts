/**
 * Stands in for `@/lib/db` in the `db-*` suites (see tests/db/tsconfig.json, which maps the
 * alias here). Application modules that `import { db } from '@/lib/db'` therefore run
 * unchanged against whichever in-memory Postgres the test installed with `setTestDb` — no
 * seam in application code, and no DATABASE_URL anywhere.
 */
import * as main from '../../lib/db/schema';
import * as radar from '../../lib/db/schema-radar';
import * as compliance from '../../lib/db/schema-compliance';
import * as ai from '../../lib/db/schema-ai';
import * as ops from '../../lib/db/schema-ops';

const schema = { ...main, ...radar, ...compliance, ...ai, ...ops };

// On globalThis, not module scope: tsx loads this file once as ESM (from the test) and once as
// CJS (from the application modules, which are .ts), and those are two module instances.
const g = globalThis as unknown as { __testDb?: Record<string | symbol, unknown> | null };

export function setTestDb(d: unknown): void {
  g.__testDb = d as Record<string | symbol, unknown>;
}

export const db = new Proxy({} as Record<string | symbol, unknown>, {
  get(_t, key) {
    const current = g.__testDb;
    if (!current) throw new Error('tests/db: no test database installed — call setTestDb() first');
    const v = current[key];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(current) : v;
  },
}) as unknown as typeof import('../../lib/db').db;

export { schema };
export const isDatabaseConfigured = true;
