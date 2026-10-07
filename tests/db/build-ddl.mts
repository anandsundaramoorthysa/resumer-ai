/** Writes the schema's DDL to argv[2] as JSON, so tests/run.mts pays for drizzle-kit once. */
import { writeFileSync } from 'node:fs';
import { buildDdl } from './pg.mjs';

const out = process.argv[2];
if (!out) throw new Error('usage: build-ddl.mts <output.json>');
writeFileSync(out, JSON.stringify(await buildDdl()));
process.exit(0);
