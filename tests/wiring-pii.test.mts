/**
 * No contact details or full name reach a model from the cover-letter and interview-prep prompts.
 * fetch is stubbed (nothing leaves the machine); every request body is captured and inspected.
 */

import { assert, suiteAsync, testAsync } from './harness.mjs';
import { generateCoverLetter, coverLetterToText, scrubForModel } from '../lib/generate/cover-letter';
import { generateInterviewPrep } from '../lib/generate/interview';
import type { JobRequirement, ResumeDocument } from '../lib/types';

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'dummy-key-for-tests';

const EMAIL = 'priya.raman@example.com';
const PHONE = '+91 98765 43210';
const NAME = 'Priya Raman';

const doc = {
  id: 'd',
  userId: 'u',
  contact: { fullName: NAME, email: EMAIL, phone: PHONE, location: 'Chennai' },
  sections: [
    {
      heading: `Experience (contact ${EMAIL})`,
      items: [{ text: `Built a billing service with Go; reach ${NAME} on ${PHONE}` }],
      groups: [
        { title: 'Engineer', subtitle: 'Acme', dateRange: '2022-2024', items: [{ text: 'Cut p95 latency 40% on a 200K-request/day service' }] },
      ],
    },
  ],
} as unknown as ResumeDocument;

const job = {
  roleTitle: 'Backend Engineer',
  company: 'Globex',
  seniority: 'mid',
  requiredSkills: ['Go'],
  preferredSkills: [],
  responsibilities: ['Own services'],
  companyContext: `Recruiter: hr@globex.io, call 080 4123 4567. Hiring for ${NAME}-like profiles.`,
} as unknown as JobRequirement;

async function captured(run: () => Promise<unknown>): Promise<string> {
  const bodies: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    bodies.push(typeof init?.body === 'string' ? init.body : String(init?.body ?? ''));
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
  try {
    await run().catch(() => undefined); // the stub never answers; only the outgoing prompt matters
  } finally {
    globalThis.fetch = real;
  }
  return bodies.join('\n');
}

const leaks = (text: string) => [EMAIL, 'hr@globex.io', '98765', '43210', '4123 4567', NAME].filter((s) => text.includes(s));

await suiteAsync('wiring: PII never reaches the model', async () => {
  await testAsync('scrubForModel redacts email, phone, profile URLs and the full name', async () => {
    const out = scrubForModel(`${NAME} (${EMAIL}, ${PHONE}) https://github.com/priya`, NAME);
    assert(!/Priya|@|98765|github\.com/.test(out) && out.includes('[candidate]') && out.includes('[email]'), out);
    // Names with regex metacharacters must not throw or over-match.
    assert(scrubForModel('A.B. (x) Smith', 'A.B. (x) Smith') === '[candidate]', 'escaped');
  });

  await testAsync('cover letter prompt carries no email, phone or full name', async () => {
    const body = await captured(() => generateCoverLetter(doc, job));
    assert(body.length > 0, 'a request was attempted');
    assert(body.includes('Cut p95 latency'), 'experience facts still go through');
    assert(body.includes('Globex'), 'company still named for context');
    assert(leaks(body).length === 0, `leaked: ${leaks(body).join(', ')}`);
  });

  await testAsync('interview prep prompt carries no email, phone or full name', async () => {
    const body = await captured(() => generateInterviewPrep(doc, job));
    assert(body.length > 0, 'a request was attempted');
    assert(body.includes('Cut p95 latency'), 'experience facts still go through');
    assert(leaks(body).length === 0, `leaked: ${leaks(body).join(', ')}`);
  });

  await testAsync('the contact line, greeting and sign-off are assembled locally', async () => {
    const text = coverLetterToText(
      { greeting: 'Dear Globex Hiring Team,', paragraphs: ['Body.'], closing: 'Thanks.', removed: [] },
      doc,
    );
    assert(text.includes(EMAIL) && text.includes(PHONE) && text.trimEnd().endsWith(NAME), 'local assembly keeps them');
  });
});
