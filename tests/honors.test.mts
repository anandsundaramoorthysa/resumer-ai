/**
 * Awards vs achievements — lib/profile/honors.ts and the steward rule built on it.
 *
 * The defect these were written against: one hackathon rank stored as an award (from the
 * LinkedIn import) and as an achievement (from the portfolio sync), printed twice on the
 * resume a few lines apart.
 */

import { asHonorType, classifyHonor, honorHashParts, honorTitleKey } from '../lib/profile/honors';
import { ruleSuggestions } from '../lib/steward/rules';
import type { StewardRecord } from '../lib/steward/types';
import { suite, test, assert } from './harness.mjs';

let n = 0;
const rec = (type: string, data: Record<string, unknown>, extra: Partial<StewardRecord> = {}): StewardRecord => ({
  id: `r${++n}`,
  type,
  source: 'github-sync',
  reviewState: 'approved',
  contentHash: `h${n}`,
  data,
  ...extra,
});

suite('honors — which of the two a fact is', () => {
  test('a prize, a rank or a named issuer is an award', () => {
    for (const title of [
      '1st of 120 teams at the XYZ Hackathon',
      'Winner, Smart India Hackathon',
      'Best Paper',
      'Dean’s List 2024',
      'Merit Scholarship',
      'Runner-up in the state quiz',
      'Gold medal, inter-college meet',
    ]) {
      assert.equal(classifyHonor({ title }), 'award', title);
    }
  });

  test('an issuer settles it even when the wording says nothing', () => {
    assert.equal(classifyHonor({ title: 'Recognised for the chatbot work' }), 'achievement');
    assert.equal(
      classifyHonor({ title: 'Recognised for the chatbot work', issuer: 'Loyola College' }),
      'award',
    );
  });

  test('the person’s own doing is an achievement', () => {
    for (const title of [
      'Shipped the admissions chatbot to 2,000 applicants',
      'Published three articles on Medium',
      'Organised a 200-person meetup',
      'Coursework',
      'Grew the newsletter to 4,000 readers',
    ]) {
      assert.equal(classifyHonor({ title }), 'achievement', title);
    }
  });

  test('the description is never read — a prize mentioned there is not a prize given', () => {
    // "…which went on to win an award" is the person describing their own work. Reading
    // the description would retype their achievement as somebody else's gift.
    assert.equal(
      classifyHonor({
        title: 'Built the campus routing app',
        description: 'It later won an award at the state expo',
      } as { title: string; description: string }),
      'achievement',
    );
  });
});

suite('honors — when two honours are one', () => {
  test('punctuation, case and the word “award” do not make two facts', () => {
    assert.equal(honorTitleKey('Best Innovation Award'), honorTitleKey('best innovation'));
    assert.equal(honorTitleKey('1st Place — XYZ Hackathon'), honorTitleKey('1st place, xyz hackathon'));
    assert.equal(honorTitleKey('Winner of the Hackathon'), honorTitleKey('Hackathon'));
  });

  test('different facts keep different keys', () => {
    assert(honorTitleKey('Best Innovation') !== honorTitleKey('Best Design'));
    assert(honorTitleKey('') === '');
  });

  test('the hash ignores the type, so the unique index refuses the second copy', () => {
    assert.deepEqual(honorHashParts({ title: 'Best Innovation Award' }), ['honor', 'best innovation']);
    assert.deepEqual(
      honorHashParts({ title: 'Best Innovation' }),
      honorHashParts({ title: 'BEST   innovation!' }),
    );
  });

  test('re-shaping for the other type keeps everything but the issuer', () => {
    const honor = { title: 'Best Paper', issuer: 'ICSE', date: '2025-03', description: 'For the caching work' };
    assert.deepEqual(asHonorType('award', honor), honor);
    assert.deepEqual(asHonorType('achievement', honor), {
      title: 'Best Paper',
      description: 'For the caching work',
      date: '2025-03',
    });
  });
});

suite('steward rule — the same honour under both types', () => {
  const honors = (records: StewardRecord[]) =>
    ruleSuggestions({ records, roles: [] }).filter((s) => s.kind === 'merge');

  test('a prize stored both ways is merged, and the award is what is kept', () => {
    const award = rec('award', { title: 'Best Innovation Award', issuer: 'XYZ Hackathon' });
    const achievement = rec('achievement', { title: 'Best Innovation', description: 'At the XYZ hackathon' });
    const [suggestion, ...rest] = honors([achievement, award]);
    assert.equal(rest.length, 0, 'one suggestion, not one per row');
    assert.equal(suggestion.recordId, award.id);
    assert.deepEqual(suggestion.removeIds, [achievement.id]);
    assert.equal(suggestion.title, 'Keep this as an award only');
    // Applying refuses if either row changed since — both must be in the basis.
    assert.deepEqual(Object.keys(suggestion.basis).sort(), [achievement.id, award.id].sort());
  });

  test('own work stored both ways keeps the achievement', () => {
    const award = rec('award', { title: 'Shipped the admissions chatbot' });
    const achievement = rec('achievement', { title: 'Shipped the admissions chatbot' });
    const [suggestion] = honors([award, achievement]);
    assert.equal(suggestion.recordId, achievement.id);
    assert.deepEqual(suggestion.removeIds, [award.id]);
    assert.equal(suggestion.title, 'Keep this as an achievement only');
  });

  test('among rows of the right type, an approved one the user typed wins', () => {
    const typed = rec('award', { title: 'Best Paper', issuer: 'ICSE' }, { source: 'manual' });
    const synced = rec('award', { title: 'Best Paper!', issuer: 'ICSE' });
    const achievement = rec('achievement', { title: 'Best Paper' });
    const [suggestion] = honors([synced, achievement, typed]);
    assert.equal(suggestion.recordId, typed.id);
    assert.equal(suggestion.removeIds?.length, 2);
  });

  test('two different honours, and one honour alone, are left alone', () => {
    assert.equal(
      honors([
        rec('award', { title: 'Best Innovation', issuer: 'XYZ' }),
        rec('achievement', { title: 'Published three articles' }),
      ]).length,
      0,
    );
    assert.equal(honors([rec('achievement', { title: 'Best Innovation' })]).length, 0);
  });

  test('a rejected row is not a reason to merge anything', () => {
    assert.equal(
      honors([
        rec('award', { title: 'Best Innovation', issuer: 'XYZ' }),
        rec('achievement', { title: 'Best Innovation' }, { reviewState: 'rejected' }),
      ]).length,
      0,
    );
  });
});
