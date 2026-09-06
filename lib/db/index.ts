import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * A connection string is only usable if it actually parses. This matters at build time:
 * some CI environments redact secret values (Netlify substitutes `***` during CLI
 * builds), and handing that to postgres() throws ERR_INVALID_URL while Next is
 * collecting page data — failing the whole build for a reason that has nothing to do
 * with the code. An unusable value is treated as absent instead, which the setup screen
 * already handles.
 */
function usableConnectionString(): string | undefined {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) return undefined;
    if (!parsed.hostname) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

const connectionString = usableConnectionString();

/**
 * Deliberately no throw at import time. A missing DATABASE_URL must not break the build
 * or prevent the app from booting — the setup screen needs to render in order to tell
 * you the URL is missing. Connections are lazy, so nothing is attempted until a query
 * actually runs, and `isDatabaseConfigured` gates every path that would run one.
 */
const globalForDb = globalThis as unknown as {
  __resumerPg?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__resumerPg ??
  postgres(connectionString ?? 'postgres://localhost:5432/resumerai', {
    max: 5,
    prepare: false,
    // Don't dial out during build/prerender when there's nothing to connect to.
    connect_timeout: 10,
    idle_timeout: 20,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.__resumerPg = client;

export const db = drizzle(client, { schema });
export { schema };
export const isDatabaseConfigured = Boolean(connectionString);
