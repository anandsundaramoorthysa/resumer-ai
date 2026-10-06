/** Replay/record fixtures: fixtures/serpapi/*.json. Server-only (node:fs). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = () => join(process.cwd(), 'fixtures', 'serpapi');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function read(name: string): unknown | null {
  const file = join(dir(), name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** A recorded response for this exact query wins; otherwise the closest bundled sample. */
export function loadFixture(engine: string, q: string): unknown | null {
  const recorded = read(`rec-${engine}-${slug(q)}.json`);
  if (recorded) return recorded;
  if (engine === 'google_news') return read('news-sample.json');
  if (engine === 'google_jobs_listing') return read('listing-sample.json');
  const t = q.toLowerCase();
  if (/data|analyst|\bbi\b|sql/.test(t)) return read('jobs-data-analyst-chennai.json');
  if (/\bml\b|machine|learning|\bai\b|scientist/.test(t)) return read('jobs-ml-engineer-hyderabad.json');
  return read('jobs-fullstack-bengaluru.json');
}

/** SERP_MODE=record: keep a real response (already key-free) for later replay. */
export function recordFixture(engine: string, q: string, json: unknown): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `rec-${engine}-${slug(q)}.json`), JSON.stringify(json, null, 2));
}
