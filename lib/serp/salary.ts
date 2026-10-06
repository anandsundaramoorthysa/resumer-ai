/**
 * Salary in LPA (lakh rupees per year) from SerpApi's own field or free text.
 * Indian postings rarely carry a structured salary, so the description is regexed.
 * Anything outside 1-200 LPA is treated as a misparse (an hourly rate, a phone number).
 */

import type { Posting } from './types';

type Salary = Posting['salaryLpa'];
const NONE: Salary = { min: 0, max: 0, source: 'none' };
const N = String.raw`(\d+(?:\.\d+)?)`;
const CUR = String.raw`(?:₹|rs\.?|inr)`;
const SEP = String.raw`\s*(?:-|to)\s*`;
const LPA_UNIT = String.raw`(?:lpa|lakhs?|lacs?|lakh\s+per\s+annum)`;

function num(s: string | undefined, k = false): number {
  return s === undefined ? NaN : Number(s) * (k ? 1000 : 1);
}

function lpaOf(text: string): [number, number] | null {
  const t = text
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[–—−]/g, '-');
  let m: RegExpMatchArray | null;

  m = t.match(new RegExp(String.raw`${CUR}?\s*${N}\s*(?:${LPA_UNIT})?${SEP}${CUR}?\s*${N}\s*${LPA_UNIT}`));
  if (m) return [num(m[1]), num(m[2])];
  m = t.match(new RegExp(String.raw`${CUR}?\s*${N}\s*${LPA_UNIT}`));
  if (m) return [num(m[1]), num(m[1])];

  // ₹40,000 - ₹60,000 per month (optionally 40k)
  const per = String.raw`(?:per\s+month|a\s+month|/\s*month|/\s*mo\b|pm\b|monthly)`;
  m = t.match(new RegExp(String.raw`${CUR}\s*${N}(k?)(?:${SEP}${CUR}?\s*${N}(k?))?\s*${per}`));
  if (m) {
    const lo = (num(m[1], m[2] === 'k') * 12) / 1e5;
    const hi = m[3] ? (num(m[3], m[4] === 'k') * 12) / 1e5 : lo;
    return [lo, hi];
  }

  // ₹8,00,000 a year / per annum
  const yr = String.raw`(?:per\s+annum|a\s+year|per\s+year|/\s*year|p\.a\.?|annually)`;
  m = t.match(new RegExp(String.raw`${CUR}?\s*${N}(?:${SEP}${CUR}?\s*${N})?\s*${yr}`));
  if (m && num(m[1]) >= 1e5) return [num(m[1]) / 1e5, (m[2] ? num(m[2]) : num(m[1])) / 1e5];

  // CTC: 12,00,000 (a bare amount)
  m = t.match(new RegExp(String.raw`ctc\s*(?:of|is|:|-)?\s*${CUR}?\s*${N}(?:${SEP}${CUR}?\s*${N})?`));
  if (m && num(m[1]) >= 1e5) return [num(m[1]) / 1e5, (m[2] ? num(m[2]) : num(m[1])) / 1e5];
  return null;
}

function valid(r: [number, number] | null): Salary | null {
  if (!r) return null;
  const [a, b] = r[0] <= r[1] ? r : [r[1], r[0]];
  if (!(a >= 1 && b <= 200)) return null;
  return { min: Math.round(a * 100) / 100, max: Math.round(b * 100) / 100, source: 'serp' };
}

export function parseSalaryLpa(text: string, serpSalary?: string): Salary {
  const fromSerp = serpSalary ? valid(lpaOf(serpSalary)) : null;
  if (fromSerp) return fromSerp;
  const fromText = valid(lpaOf(text));
  return fromText ? { ...fromText, source: 'regex' } : { ...NONE };
}
