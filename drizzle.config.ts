import 'dotenv/config';
import type { Config } from 'drizzle-kit';

// Env is loaded here rather than via a CLI wrapper — avoids depending on whichever
// `dotenv` binary happens to be first on PATH.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set. Add it to .env before running db commands.');
}

export default {
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
} satisfies Config;
