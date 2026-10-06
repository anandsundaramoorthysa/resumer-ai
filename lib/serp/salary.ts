/**
 * Salary in LPA (lakh rupees per year) from SerpApi's own field or free text.
 * Indian postings rarely carry a structured salary, so the description is regexed.
 * Free text needs a salary cue near the figure ("We serve 50 lakh customers" is not pay),
 * foreign currencies and hourly rates are rejected, and anything outside 1-200 LPA is
 * treated as a misparse (a phone number, a headcount).
 */

import type { Posting } from './types';

type Salary = Posting['salaryLpa'];
const NONE: Salary = { min: 0, max: 0, source: 'none' };
const N = String.raw`(\d+(?:\.\d+)?)`;
const CUR = String.raw`(?:₹|rs\.?|inr)`;
const SEP = String.raw`\s*(?:-|to)\s*`;
// "lakh crore" / "lakh customers" are headcounts and turnover, not pay.
const LPA_UNIT = String.raw`(?:lpa|lakhs?(?!\s*(?:crores?|cr\b|customers|users|people|downloads))|lacs?|l\b)`;
const CR_UNIT = String.raw`(?:crores?|cr\b)`;

const CUE = /salary|ctc|compensation|package|stipend|remuneration|per\s+annum|p\.a|\blpa\b|₹|\brs\b|\binr\b/;
const FOREIGN = /[$€£]|\b(?:usd|eur|gbp)\b/;
const HOURLY = /\b(?:per\s+hour|an\s+hour|\/\s*h(?:ou)?r|hourly|per\s+day|daily)\b/;

const num = (s: string | undefined, k = false): number => (s === undefined ? NaN : Number(s) * (k ? 1000 : 1));

type Hit = { r: [number, number]; i: number; len: number };

function find(t: string): Hit | null {
  const take = (m: RegExpMatchArray | null, r: [number, number] | null): Hit | null =>
    m && r ? { r, i: m.index ?? 0, len: m[0].length } : null;
  let m: RegExpMatchArray | null;

  // 12-18 LPA, ₹8L - ₹12L, 10L
  m = t.match(new RegExp(String.raw`${CUR}?\s*${N}\s*(?:${LPA_UNIT})?${SEP}${CUR}?\s*${N}\s*${LPA_UNIT}`));
  if (m) return take(m, [num(m[1]), num(m[2])]);
  m = t.match(new RegExp(String.raw`${CUR}?\s*${N}\s*${LPA_UNIT}`));
  if (m) return take(m, [num(m[1]), num(m[1])]);

  // ₹1.2 Cr, 1-2 crore
  m = t.match(new RegExp(String.raw`${CUR}?\s*${N}(?:${SEP}${CUR}?\s*${N})?\s*${CR_UNIT}`));
  if (m) return take(m, [num(m[1]) * 100, (m[2] ? num(m[2]) : num(m[1])) * 100]);

  // ₹40,000 - ₹60,000 per month, "stipend: 15000 per month" (optionally 40k); cue checked by the caller
  const per = String.raw`(?:per\s+month|a\s+month|/\s*month|/\s*mo\b|pm\b|monthly)`;
  m = t.match(new RegExp(String.raw`${CUR}?\s*${N}(k?)(?:${SEP}${CUR}?\s*${N}(k?))?\s*${per}`));
  if (m) {
    const lo = (num(m[1], m[2] === 'k') * 12) / 1e5;
    const hi = m[3] ? (num(m[3], m[4] === 'k') * 12) / 1e5 : lo;
    return take(m, [lo, hi]);
  }

  // ₹8,00,000 a year / per annum
  const yr = String.raw`(?:per\s+annum|a\s+year|per\s+year|/\s*year|p\.a\.?|annually)`;
  m = t.match(new RegExp(String.raw`${CUR}?\s*${N}(?:${SEP}${CUR}?\s*${N})?\s*${yr}`));
  if (m && num(m[1]) >= 1e5) return take(m, [num(m[1]) / 1e5, (m[2] ? num(m[2]) : num(m[1])) / 1e5]);

  // CTC: 12,00,000 (a bare amount)
  m = t.match(new RegExp(String.raw`ctc\s*(?:of|is|:|-)?\s*${CUR}?\s*${N}(?:${SEP}${CUR}?\s*${N})?`));
  if (m && num(m[1]) >= 1e5) return take(m, [num(m[1]) / 1e5, (m[2] ? num(m[2]) : num(m[1])) / 1e5]);
  return null;
}

function parse(text: string, needCue: boolean): Salary | null {
  const t = text
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[–—−]/g, '-');
  const h = find(t);
  if (!h) return null;
  const end = h.i + h.len;
  if (FOREIGN.test(t.slice(Math.max(0, h.i - 15), end + 15))) return null;
  if (HOURLY.test(t.slice(end, end + 15))) return null;
  if (needCue && !CUE.test(t.slice(Math.max(0, h.i - 40), end + 40))) return null;
  const [a, b] = h.r[0] <= h.r[1] ? h.r : [h.r[1], h.r[0]];
  if (!(a >= 1 && b <= 200)) return null;
  return { min: Math.round(a * 100) / 100, max: Math.round(b * 100) / 100, source: 'serp' };
}

export function parseSalaryLpa(text: string, serpSalary?: string): Salary {
  // SerpApi's own salary field is already a salary: no cue needed.
  const fromSerp = serpSalary ? parse(serpSalary, false) : null;
  if (fromSerp) return fromSerp;
  const fromText = parse(text, true);
  return fromText ? { ...fromText, source: 'regex' } : { ...NONE };
}
