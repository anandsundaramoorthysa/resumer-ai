/**
 * Replay/record fixtures. The bundled samples are static JSON imports so they ship inside
 * the server bundle on Netlify/Vercel (no file tracing needed). node:fs is used only for
 * SERP_MODE=record writes and for optional recorded `rec-*.json` overrides in
 * fixtures/serpapi (absent on a deployed build, which is fine).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dataAnalyst from '../../fixtures/serpapi/jobs-data-analyst-chennai.json';
import fullstack from '../../fixtures/serpapi/jobs-fullstack-bengaluru.json';
import mlEngineer from '../../fixtures/serpapi/jobs-ml-engineer-hyderabad.json';
import listing from '../../fixtures/serpapi/listing-sample.json';
import news from '../../fixtures/serpapi/news-sample.json';

const dir = () => join(process.cwd(), 'fixtures', 'serpapi');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function recorded(name: string): unknown | null {
  try {
    const file = join(dir(), name);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

/** A recorded response for this exact query wins; otherwise the closest bundled sample. Throws if there is none. */
export function loadFixture(engine: string, q: string): unknown {
  const rec = recorded(`rec-${engine}-${slug(q)}.json`);
  if (rec) return rec;
  let found: unknown;
  if (engine === 'google_news') found = news;
  else if (engine === 'google_jobs_listing') found = listing;
  else if (engine === 'google_jobs') {
    const t = q.toLowerCase();
    found = /data|analyst|\bbi\b|sql/.test(t)
      ? dataAnalyst
      : /\bml\b|machine|learning|\bai\b|scientist/.test(t)
        ? mlEngineer
        : fullstack;
  }
  if (!found) throw new Error(`No SerpApi sample fixture for engine "${engine}".`);
  return found;
}

/** SERP_MODE=record: keep a real response (already key-free) for later replay. */
export function recordFixture(engine: string, q: string, json: unknown): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `rec-${engine}-${slug(q)}.json`), JSON.stringify(json, null, 2));
}
