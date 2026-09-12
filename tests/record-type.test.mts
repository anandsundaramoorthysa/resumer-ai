/**
 * Where a newly-extracted fact gets filed — lib/profile/record-type.ts.
 *
 * This is the decision that used to be a prompt's opinion, and it is worth pinning because
 * a mis-filed record is worse than a missing one: it prints, in the wrong section, and the
 * person whose resume it is has no way to see that it happened. The measured failure this
 * replaced is in the first suite below.
 *
 * Two directions matter, and they are not symmetrical. Filing a real certification as a
 * skill understates a true claim. Filing anything as a certification overstates one, and
 * puts an institution's name behind something nobody issued — so the rules may only
 * promote on an explicit cue, and `fileRecord` must refuse rather than guess.
 */

import { suite, test, assert } from './harness.mjs';
import {
  classifyRecordType,
  fileRecord,
  CREDENTIAL_TYPES,
} from '../lib/profile/record-type';

const typeOf = (data: Record<string, unknown>) => classifyRecordType(data).type;

suite('the misfiling this exists to stop', () => {
  /*
   * Measured before the rules existed, with lib/skills/categories.ts as it stands:
   *   classifySkill('AWS Certified Solutions Architect') → null
   *   classifySkill('Certified Scrum Master')            → null
   *   classifySkill('Six Sigma Black Belt')              → null
   *   classifySkill('Google Analytics Certified')        → null
   * and the enrichment answer path's `suggestedSkillCategory(topic) ?? 'tool'` turned each
   * into a skill of category `tool`, printed under "tools" on the resume.
   */
  for (const name of [
    'AWS Certified Solutions Architect',
    'Certified Scrum Master',
    'Six Sigma Black Belt',
    'Google Analytics Certified',
    'Deep Learning Specialization',
    'PMP',
  ]) {
    test(`"${name}" is a certification, not a skill`, () => {
      assert.equal(typeOf({ name }), 'certification');
      assert.equal(fileRecord('skill', { name }).type, 'certification');
      assert.equal(fileRecord('skill', { name }).moved, true);
    });
  }

  test('a real skill whose name merely contains the word certificate stays a skill', () => {
    // "Certificate Management" is PKI work. An earlier cut of the rule matched the bare
    // noun and filed it as a certification, which is the same class of error in reverse.
    assert.equal(typeOf({ name: 'Certificate Management' }), 'skill');
    assert.equal(fileRecord('skill', { name: 'Certificate Management' }).moved, false);
  });

  test('a named skill is still a skill', () => {
    assert.equal(typeOf({ name: 'PostgreSQL' }), 'skill');
    assert.equal(typeOf({ name: 'Agile' }), 'skill');
    assert.equal(typeOf({ name: 'Screaming Frog' }), 'skill');
  });
});

suite('the other types', () => {
  test('a venue makes it a publication, whatever the model called it', () => {
    assert.equal(typeOf({ title: 'A Study of Queues', venue: 'IEEE Access' }), 'publication');
    assert.equal(fileRecord('achievement', { title: 'A Study of Queues', venue: 'IEEE Access' }).type, 'publication');
  });

  test('publication language in the title is enough on its own', () => {
    assert.equal(typeOf({ title: 'Paper on retrieval latency' }), 'publication');
  });

  test('being picked out is an award', () => {
    assert.equal(typeOf({ title: 'Winner, Smart India Hackathon' }), 'award');
    assert.equal(typeOf({ title: "Dean's List" }), 'award');
    assert.equal(typeOf({ title: 'Gold medal, inter-college meet' }), 'award');
  });

  test('a qualification from an institution is education', () => {
    assert.equal(
      typeOf({ credential: 'B.Sc. Computer Science', institution: 'Loyola College' }),
      'education',
    );
  });

  test('a degree with nobody to have awarded it is not education', () => {
    // The institution is the other half of the claim. Without it there is no qualification,
    // only a word — and inventing the college is exactly what NFR-8 is about.
    assert.equal(typeOf({ credential: 'B.Sc. Computer Science' }), null);
  });

  test('nothing naming it gets no answer', () => {
    assert.equal(typeOf({ description: 'did some things' }), null);
    assert.equal(classifyRecordType({}).type, null);
  });

  test('cues in a description are ignored', () => {
    // A project description saying "this won us the client" must not become an award.
    assert.equal(typeOf({ name: 'Tidewater', description: 'it won us the client' }), null);
  });
});

suite('what happens when the rules cannot tell', () => {
  test('an unsupported certification is handed back, not stored', () => {
    const filing = fileRecord('certification', { name: 'Helix', issuer: '' });
    assert.equal(filing.confirm, true);
    assert.equal(filing.moved, false);
    assert.ok(filing.why.length > 0);
  });

  test('every type that asserts a third party gave them something is refused the same way', () => {
    for (const type of CREDENTIAL_TYPES) {
      if (type === 'award') continue; // has a downgrade instead — see below
      assert.equal(fileRecord(type, { name: 'Helix' }).confirm, true, type);
    }
  });

  test('award without a cue is downgraded to achievement, never refused', () => {
    // A thing you did is a claim about you; a thing you won is a claim about a jury. The
    // safe direction is the only one available.
    const filing = fileRecord('award', { title: 'Shipped the billing rewrite' });
    assert.equal(filing.type, 'achievement');
    assert.equal(filing.moved, true);
    assert.equal(filing.confirm, false);
  });

  test('achievement is never promoted to award', () => {
    const filing = fileRecord('achievement', { title: 'Shipped the billing rewrite' });
    assert.equal(filing.type, 'achievement');
    assert.equal(filing.moved, false);
    assert.equal(filing.confirm, false);
  });

  test('an achievement naming who gave it is an award, by the shared rule', () => {
    const filing = fileRecord('achievement', { title: 'Best Speaker', issuer: 'IEEE' });
    assert.equal(filing.type, 'award');
    assert.equal(filing.moved, true);
    assert.equal(fileRecord('achievement', { title: 'College topper' }).type, 'award');
  });

  test('a type that asserts nothing about anyone else is left alone', () => {
    for (const type of ['project', 'interest', 'summary', 'volunteering', 'writing']) {
      const filing = fileRecord(type, { name: 'Tidewater', title: 'Tidewater' });
      assert.equal(filing.confirm, false, type);
      assert.equal(filing.type, type, type);
    }
  });
});
