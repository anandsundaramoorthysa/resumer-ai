import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

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
