/** lib/quality/length.ts — a long bullet costs the printed lines it wraps to, not one. */

import { assert, suite, test } from './harness.mjs';
import { CHARS_PER_LINE, estimatedLines, lengthVerdict } from '../lib/quality/length';
import type { JobRequirement, ResumeDocument } from '../lib/types';

const job = {
  roleTitle: 'Engineer', seniority: 'mid', category: 'general', requiredSkills: [], preferredSkills: [],
  responsibilities: [], atsKeywords: [], tone: 'neutral', confidence: 0.9, flags: [],
} as JobRequirement;

const docOf = (texts: string[]): ResumeDocument =>
  ({
    id: 'd', userId: 'u', contact: { fullName: 'A', email: 'a@b.c' }, jobRequirement: job, renderMode: 'ats-strict',
    recordHashSnapshot: [], createdAt: new Date(),
    sections: [{ key: 'experience', heading: 'Experience', items: texts.map((t) => ({ text: t, sourceRecordId: null })) }],
  }) as unknown as ResumeDocument;

suite('wrapped-line estimate', () => {
  test('short text is one line, long text is ceil(len / chars-per-line)', () => {
    assert(estimatedLines('x'.repeat(CHARS_PER_LINE)) === 1, 'exactly one line');
    assert(estimatedLines('x'.repeat(CHARS_PER_LINE + 1)) === 2, 'one over wraps');
    assert(estimatedLines('x'.repeat(CHARS_PER_LINE * 3)) === 3, 'three lines');
    assert(estimatedLines('') === 1, 'an empty item still occupies a line');
  });
  test('skills rows measure the values column, not the label', () => {
    assert(estimatedLines('Languages: ' + 'a, '.repeat(40), 'skills') === 2, 'wraps in the narrow column');
  });
  test('the same item count is "ok" short and "long" once the bullets wrap', () => {
    const short = Array.from({ length: 40 }, (_, i) => `Shipped thing ${i} with measurable effect on checkout latency`);
    const longText = Array.from({ length: 40 }, (_, i) => `Shipped thing ${i} ` + 'with a very detailed long description '.repeat(4));
    assert(lengthVerdict(docOf(short)) !== 'long', 'one line each fits');
    assert(lengthVerdict(docOf(longText)) === 'long', 'three lines each overruns the page');
  });
});
