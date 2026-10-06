import { suite, test, assert, testAsync, report } from './harness.mjs';
import { buildProfileDigest, planSearch } from '../lib/radar/planner';
import type { ProfileRecord, RoleRecord } from '../lib/types';

const role = (id: string, title: string, startDate: string, endDate: string): RoleRecord => ({
  id, userId: 'u', title, company: 'SecretCorp', startDate, endDate, source: 'manual', contentHash: id, reviewState: 'approved',
});
const roles = [role('1', 'Junior Developer', '2020-01', '2021-12'), role('2', 'Backend Engineer', '2022-01', 'present')];
const records = [
  { id: 's', userId: 'u', type: 'skill', name: 'Go', category: 'language', tags: [], contentHash: 's', source: 'manual', flaggedForRemoval: false, reviewState: 'approved', createdAt: new Date(), updatedAt: new Date() },
] as ProfileRecord[];
const contact = { fullName: 'Jane Doe', email: 'jane@x.com', location: 'Pune, India' };

suite('buildProfileDigest', () => {
  test('compact, no PII', () => {
    const d = buildProfileDigest(records, roles, contact);
    assert.ok(d.length <= 1200);
    assert.ok(d.includes('Pune') && d.includes('Backend Engineer'));
    assert.ok(!/SecretCorp|Jane|jane@/.test(d));
  });
});

const digest = buildProfileDigest(records, roles, contact);
const throwing = async (): Promise<never> => {
  throw new Error('boom');
};
const q = (s: string) => ({ q: s, why: '' });

await testAsync('planSearch falls back to rules when the generator throws', async () => {
  const plan = await planSearch({ digest, roles, contact }, throwing);
  assert.deepEqual(plan.queries.map((x) => x.q), ['Backend Engineer Pune', 'Junior Developer Pune']);
  assert.equal(plan.location, 'Pune');
});
await testAsync('planSearch defaults city and role with an empty profile', async () => {
  const plan = await planSearch({ digest: '', roles: [], contact: { fullName: '', email: '' } }, throwing);
  assert.deepEqual(plan.queries.map((x) => x.q), ['software engineer Bengaluru']);
});
await testAsync('planSearch uses model output, deduped and capped at 3', async () => {
  const plan = await planSearch({ digest, roles, contact }, async () => ({
    data: { queries: [q('A Pune'), q('a pune'), q('B Pune')], location: '', seniority: 'mid', rationale: 'r' },
  }));
  assert.deepEqual(plan.queries.map((x) => x.q), ['A Pune', 'B Pune']);
  assert.equal(plan.location, 'Pune');
});

report();
