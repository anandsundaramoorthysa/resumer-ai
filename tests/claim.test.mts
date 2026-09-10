/**
 * Turning what someone says about themselves into profile records — lib/profile/claim.ts.
 *
 * This is the one place in the app where a model's output becomes a permanent claim about
 * a person, written into the profile every future resume is checked against. The prompt
 * asks it to use only their words; these pin that the code does not depend on it having
 * obeyed. The dangerous direction is the generous one: a record that survives when the
 * sentence does not support it puts something on a resume that its owner never said, and
 * they will have clicked Save on it.
 */

import { suite, test, assert } from './harness.mjs';
import {
  groundClaims,
  inventsFigures,
  mentions,
  toCommitPayload,
  type ClaimOutput,
  type ClaimRecord,
} from '../lib/profile/claim';

const SENTENCE =
  'I have SEO knowledge — I did SEO on all my own products and for ferventers.com, mostly technical audits.';

function record(over: Partial<ClaimRecord>): ClaimRecord {
  return {
    type: 'skill',
    name: '', title: '', text: '', description: '', issuer: '', institution: '',
    credential: '', field: '', venue: '', role: '', organization: '', category: '',
    proficiency: '', date: '', url: '', stack: [], impactMetrics: [], tags: [],
    ...over,
  };
}

function claim(over: Partial<ClaimOutput>): ClaimOutput {
  return { records: [], roles: [], unplaced: [], ...over };
}

suite('what counts as something they said', () => {
  test('their own word, exactly', () => {
    assert.equal(mentions(SENTENCE, 'SEO'), true);
  });

  test('the expansion of an acronym they used', () => {
    // The model spelling out what they abbreviated is the same skill, not a new claim.
    assert.equal(mentions(SENTENCE, 'Search Engine Optimization'), true);
  });

  test('but an unrelated phrase sharing one word is not', () => {
    assert.equal(mentions('I use Google Sheets daily', 'Google Analytics Certification'), false);
  });

  test('a site they named', () => {
    assert.equal(mentions(SENTENCE, 'ferventers.com'), true);
  });

  test('something they never mentioned', () => {
    assert.equal(mentions(SENTENCE, 'Google Analytics'), false);
    assert.equal(mentions(SENTENCE, 'Semrush certification'), false);
  });

  test('an empty value is not a mention', () => {
    assert.equal(mentions(SENTENCE, '   '), false);
  });
});

suite('figures are never invented', () => {
  test('a percentage they did not give is refused', () => {
    const r = record({ type: 'project', name: 'ferventers.com', description: 'Grew organic traffic 40%' });
    assert.equal(inventsFigures(r, SENTENCE), true);
  });

  test('a year they did not give is refused', () => {
    const r = record({ type: 'certification', name: 'SEO certificate', issuer: 'Google', date: '2023' });
    assert.equal(inventsFigures(r, SENTENCE), true);
  });

  test('a figure they did give is fine', () => {
    const said = 'I ran SEO for 3 client sites last year';
    const r = record({ type: 'project', name: 'client SEO', description: 'SEO for 3 client sites' });
    assert.equal(inventsFigures(r, said), false);
  });

  test('a record with no figures at all is fine', () => {
    assert.equal(inventsFigures(record({ name: 'SEO' }), SENTENCE), false);
  });
});

suite('grounding the whole answer', () => {
  test('the skill and the site they named both survive', () => {
    const out = groundClaims(
      claim({
        records: [
          record({ type: 'skill', name: 'SEO', category: 'tool' }),
          record({ type: 'project', name: 'ferventers.com', description: 'Technical SEO audits' }),
        ],
      }),
      SENTENCE,
    );
    assert.equal(out.records.length, 2);
    assert.deepEqual(out.dropped, []);
  });

  test('a certificate they never claimed is dropped, and said to be dropped', () => {
    const out = groundClaims(
      claim({
        records: [
          record({ type: 'skill', name: 'SEO', category: 'tool' }),
          record({ type: 'certification', name: 'Google Analytics Certification', issuer: 'Google' }),
        ],
      }),
      SENTENCE,
    );
    assert.deepEqual(out.records.map((r) => r.name), ['SEO']);
    assert.equal(out.dropped.length, 1);
    assert.match(out.dropped[0], /didn't/);
  });

  test('a classification nobody would type does not sink the record', () => {
    // `skill` identifies itself by name AND category, and nobody writes "tool" in a
    // sentence about themselves — requiring it dropped every skill anyone described.
    const out = groundClaims(
      claim({ records: [record({ type: 'skill', name: 'SEO', category: 'tool' })] }),
      SENTENCE,
    );
    assert.deepEqual(out.records.map((r) => r.name), ['SEO']);
  });

  test('an issuer they never named sinks it, even when the subject is theirs', () => {
    // The subject here IS in the sentence, so this reaches the issuer rule rather than
    // being refused for its name — which is what makes it a test of the issuer rule.
    const out = groundClaims(
      claim({ records: [record({ type: 'certification', name: 'SEO', issuer: 'Google' })] }),
      SENTENCE,
    );
    assert.equal(out.records.length, 0);
    assert.match(out.dropped[0], /Google/);
  });

  test('a record with an invented metric is dropped', () => {
    const out = groundClaims(
      claim({
        records: [record({ type: 'project', name: 'ferventers.com', description: 'Grew traffic 40%' })],
      }),
      SENTENCE,
    );
    assert.equal(out.records.length, 0);
    assert.match(out.dropped[0], /figure you didn't give/);
  });

  test('a record with nothing identifying it is dropped', () => {
    const out = groundClaims(claim({ records: [record({ type: 'skill' })] }), SENTENCE);
    assert.equal(out.records.length, 0);
    assert.equal(out.dropped.length, 1);
  });

  test('an employer they did not describe is never created', () => {
    const out = groundClaims(
      claim({
        roles: [
          {
            title: 'SEO Manager',
            company: 'Google',
            startDate: '2023-01',
            endDate: 'present',
            bullets: [],
          },
        ],
      }),
      SENTENCE,
    );
    assert.equal(out.roles.length, 0);
    assert.match(out.dropped[0], /you didn't mention|you didn't describe/);
  });

  test('what they said that fits nothing comes back rather than vanishing', () => {
    const out = groundClaims(
      claim({ unplaced: ['mostly technical audits'] }),
      SENTENCE,
    );
    assert.deepEqual(out.unplaced, ['mostly technical audits']);
  });
});

suite('handing it to the importer', () => {
  test('a bullet gets an action when the model left one out', () => {
    const out = toCommitPayload({
      records: [],
      roles: [
        {
          title: 'Freelance SEO',
          company: '',
          startDate: '',
          endDate: '',
          bullets: [{ text: 'Ran technical SEO audits', action: '', scale: '', outcome: '' }],
        },
      ],
      dropped: [],
      unplaced: [],
    });
    assert.equal(out.roles[0].bullets[0].action, 'Ran technical SEO audits');
    // An ongoing role by default: the importer requires an end date, and "present" is the
    // only honest one when nobody said it ended.
    assert.equal(out.roles[0].endDate, 'present');
  });

  test('empty fields are passed through for the importer to drop', () => {
    const out = toCommitPayload({
      records: [record({ type: 'skill', name: 'SEO' })],
      roles: [],
      dropped: [],
      unplaced: [],
    });
    assert.equal(out.records[0].name, 'SEO');
    assert.equal(out.records[0].issuer, '');
  });
});
