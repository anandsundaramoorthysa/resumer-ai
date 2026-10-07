/** Role identity wired into the import resolver: distinct jobs stay distinct, spellings of one merge. */

import { assert, suite, test } from './harness.mjs';
import { resolveRoles } from '../lib/import/commit';
import { sameJob } from '../lib/sync/roles';

const stored = (id: string, company: string, title: string, startDate: string, endDate: string) => ({
  id,
  contentHash: `h-${id}`,
  company,
  title,
  startDate,
  endDate,
});

suite('wiring: role identity in imports', () => {
  test('intern then full-time at the same company are two jobs (gap, and adjacent)', () => {
    const s = [stored('intern', 'Acme', 'Backend Developer Intern', '2022-06', '2022-12')];
    const gap = resolveRoles(s, [{ company: 'Acme', title: 'Backend Developer', startDate: '2023-06', endDate: 'present' }]);
    assert(gap.fresh.length === 1 && 'newIndex' in gap.targets[0], 'gap: new job');

    const adjacent = [stored('intern', 'Acme', 'Backend Developer Intern', '2022-06', '2023-02')];
    const r = resolveRoles(adjacent, [{ company: 'Acme', title: 'Backend Developer', startDate: '2023-03', endDate: 'present' }]);
    assert(r.fresh.length === 1, 'adjacent conversion: new job');
  });

  test('a re-spelling of the same job (dates overlap) still lands on the stored row', () => {
    const s = [stored('a', 'Acme Inc.', 'Backend Developer', '2022-01', '2023-12')];
    const r = resolveRoles(s, [{ company: 'Acme', title: 'Backend Developer', startDate: '2022', endDate: '2023' }]);
    assert('existingId' in r.targets[0] && r.targets[0].existingId === 'a' && r.fresh.length === 0, JSON.stringify(r));
  });

  test('bullets are not filed under the wrong job when two stored jobs share an identity', () => {
    const s = [
      stored('intern', 'Acme', 'Backend Developer Intern', '2021-06', '2021-12'),
      stored('full', 'Acme', 'Backend Developer', '2023-06', 'present'),
    ];
    const r = resolveRoles(s, [
      { company: 'Acme', title: 'Backend Developer', startDate: '2023-07', endDate: 'present' },
      { company: 'Acme', title: 'Backend Developer Intern', startDate: '2021-07', endDate: '2021-11' },
    ]);
    const ids = r.targets.map((t) => ('existingId' in t ? t.existingId : 'new'));
    assert(ids[0] === 'full' && ids[1] === 'intern', ids.join());
  });

  test('Tamil and Hindi companies keep their identity: different ones never merge, same one does', () => {
    const s = [
      stored('ta', 'இன்ஃபோசிஸ்', 'மென்பொருள் பொறியாளர்', '2020-01', '2021-12'),
      stored('hi', 'टाटा कंसल्टेंसी', 'सॉफ्टवेयर इंजीनियर', '2020-01', '2021-12'),
    ];
    const r = resolveRoles(s, [
      { company: 'டிசிஎஸ்', title: 'மென்பொருள் பொறியாளர்', startDate: '2020-01', endDate: '2021-12' }, // other Tamil employer
      { company: 'इन्फोसिस', title: 'सॉफ्टवेयर इंजीनियर', startDate: '2020-01', endDate: '2021-12' }, // other Hindi employer
      { company: 'இன்ஃபோசிஸ்', title: 'மென்பொருள் பொறியாளர்', startDate: '2020', endDate: '2021' }, // same as stored 'ta'
      { company: 'टाटा कंसल्टेंसी', title: 'सॉफ्टवेयर इंजीनियर', startDate: '2020-02', endDate: '2021-11' }, // same as 'hi'
    ]);
    const t = r.targets.map((x) => ('existingId' in x ? x.existingId : 'new'));
    assert(t.join() === 'new,new,ta,hi', t.join());
    assert(r.fresh.length === 2, `${r.fresh}`);
  });

  test('two empty-identity roles never merge; two new roles in one file that are the same job do', () => {
    const e = resolveRoles([], [
      { company: '🚀', title: '!!!', startDate: '2022-01', endDate: '2022-06' },
      { company: '🔥', title: '???', startDate: '2022-01', endDate: '2022-06' },
    ]);
    assert(e.fresh.length === 2, 'distinct raw identities');
    const dup = resolveRoles([], [
      { company: 'Acme', title: 'Engineer', startDate: '2022-01', endDate: '2022-12' },
      { company: 'Acme Pvt. Ltd.', title: 'Engineer', startDate: '2022', endDate: '2022' },
    ]);
    assert(dup.fresh.length === 1 && 'newIndex' in dup.targets[1] && dup.targets[1].newIndex === 0, JSON.stringify(dup));
  });

  test('sameJob agrees (sanity, used by records.ts and the sync)', () => {
    assert(!sameJob(
      { company: 'Acme', title: 'Dev Intern', startDate: '2022-06', endDate: '2022-12' },
      { company: 'Acme', title: 'Dev', startDate: '2023-06', endDate: 'present' },
    ), 'intern vs later full-time');
  });
});
