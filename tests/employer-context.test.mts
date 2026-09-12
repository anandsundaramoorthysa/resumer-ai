/**
 * The guard on employer research — lib/profile/employer-context.ts.
 *
 * This is the file that decides whether a fact read off a company's website may appear in
 * a sentence about the user. NFR-8 is the whole point, so each case below is a way the
 * feature would break it if the guard were not there.
 */

import { groundEmployerRewrite, safeQuestion } from '../lib/profile/employer-context';
import { suite, test, assert } from './harness.mjs';

const BULLET = 'Built the ingestion service for the carrier portal';
const FACTS = [
  'Acme is a logistics platform used by 200 carriers across India.',
  'Acme was founded in 2016 and employs around 80 people.',
];
const ground = (candidate: string, facts: readonly string[] = FACTS) =>
  groundEmployerRewrite({ candidate, bullet: BULLET, facts, company: 'Acme' });

suite('employer research — what may reach a bullet', () => {
  test('a company number is allowed only while the sentence says whose it is', () => {
    const attributed = ground(
      'Built the ingestion service for the carrier portal at Acme, a logistics platform used by 200 carriers',
    );
    assert(attributed.text !== null, `refused: ${JSON.stringify(attributed.violations)}`);

    // The same figure, with the company's name taken out, reads as the user's own scale.
    const bare = ground('Built the ingestion service for a portal used by 200 carriers');
    assert.equal(bare.text, null);
    assert.deepEqual(bare.violations, [{ kind: 'scope', token: 'Acme' }]);
  });

  test('a number that is in neither the bullet nor the page is refused', () => {
    const out = ground('Built the ingestion service at Acme, cutting handoff time 40%');
    assert.equal(out.text, null);
    assert(out.violations.some((v) => v.kind === 'number' && v.token === '40%'));
  });

  test('an invented company is refused even when everything else holds', () => {
    const out = ground('Built the ingestion service at Acme, a Stripe partner');
    assert.equal(out.text, null);
    assert(out.violations.some((v) => v.kind === 'entity' && v.token === 'stripe'));
  });

  test('the hedge the user wrote cannot be dropped, however long the page was', () => {
    // The regression this exists for: `findUngroundedTokens` switches its hedge check off
    // once the source passes SINGLE_CLAIM_CHARS, and the company facts push it past that.
    const longFacts = [FACTS[0].padEnd(500, ' and more about the company')];
    const out = groundEmployerRewrite({
      candidate: 'Built the ingestion service at Acme',
      bullet: 'Helped build the ingestion service',
      facts: longFacts,
      company: 'Acme',
    });
    assert.equal(out.text, null);
    assert.deepEqual(out.violations, [{ kind: 'scope', token: 'helped' }]);
  });

  test('claiming to have led what the bullet never led is refused', () => {
    const out = ground('Led the ingestion service build at Acme');
    assert.equal(out.text, null);
    assert(out.violations.some((v) => v.kind === 'scope' && v.token === 'led'));
  });

  test('a rewrite that adds nothing from the web still passes on the bullet alone', () => {
    const out = ground('Built the carrier portal ingestion service', []);
    assert.equal(out.text, 'Built the carrier portal ingestion service');
  });

  test('an empty or unchanged rewrite is nothing to offer', () => {
    assert.equal(ground('   ').text, null);
    assert.equal(ground(BULLET).text, null);
    assert.deepEqual(ground(BULLET).violations, []);
  });
});

suite('employer research — questions never suggest the answer', () => {
  test('a question carrying a figure the user never gave is dropped', () => {
    assert.equal(safeQuestion('Did it cut handoff time by 40%?', BULLET), null);
    assert.equal(safeQuestion('Was it the 200 carriers?', BULLET), null);
  });

  test('a figure the bullet already states may be quoted back', () => {
    const bullet = 'Built the ingestion service for 12 carriers';
    assert.equal(
      safeQuestion('What changed for those 12 carriers?', bullet),
      'What changed for those 12 carriers?',
    );
  });

  test('a plain question survives, and an empty one does not', () => {
    assert.equal(
      safeQuestion('  How many carriers used it?  ', BULLET),
      'How many carriers used it?',
    );
    assert.equal(safeQuestion('Why?', BULLET), null);
  });
});
