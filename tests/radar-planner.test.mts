import { suite, test, assert, testAsync, report } from './harness.mjs';
import { buildProfileDigest, planSearch, rulesPlan, cityOf } from '../lib/radar/planner';
import type { ProfileRecord, RoleRecord } from '../lib/types';

const role = (id: string, title: string, startDate: string, endDate: string, company = 'SecretCorp'): RoleRecord => ({
  id, userId: 'u', title, company, startDate, endDate, source: 'manual', contentHash: id, reviewState: 'approved',
});
const skill = (name: string) =>
  ({ id: name, userId: 'u', type: 'skill', name, category: 'language', tags: [], contentHash: name, source: 'manual', flaggedForRemoval: false, reviewState: 'approved', createdAt: new Date(), updatedAt: new Date() }) as ProfileRecord;
const roles = [role('1', 'Junior Developer', '2020-01', '2021-12'), role('2', 'Backend Engineer', '2022-01', 'present')];
const records = [skill('Go')];
const contact = { fullName: 'Jane Doe', email: 'jane@x.com', location: 'Pune, India' };
const c = (location?: string) => ({ fullName: '', email: '', location });

suite('buildProfileDigest', () => {
  test('compact, no PII', () => {
    const d = buildProfileDigest(records, roles, contact);
    assert.ok(d.length <= 1200);
    assert.ok(d.includes('Pune') && d.includes('Backend Engineer'));
    assert.ok(!/SecretCorp|Jane|jane@/.test(d));
  });
  test('strips emails and phone numbers that leak through titles or skills', () => {
    const d = buildProfileDigest([skill('call +91 98765 43210 now'), skill('me@x.com')], [role('1', 'Engineer jo@y.io', '2022-01', 'present')], contact);
    assert.ok(!/@|98765|43210/.test(d), d);
  });
  test('company names are removed from titles', () => {
    const d = buildProfileDigest([], [role('1', 'Engineer at Google', '2022-01', 'present'), role('2', 'Analyst - Acme', '2020-01', '2021-01', 'Acme')], contact);
    assert.ok(d.includes('Engineer') && d.includes('Analyst') && !/Google|Acme/.test(d), d);
  });
});

suite('cityOf', () => {
  test('prefers a real city over Remote; Remote only when alone', () => {
    assert.equal(cityOf(c('Remote, Pune')), 'Pune');
    assert.equal(cityOf(c('Remote')), 'Remote');
    assert.equal(cityOf(c(undefined)), 'Bengaluru');
  });
  test('old city names normalised', () => {
    assert.equal(cityOf(c('Bangalore, India')), 'Bengaluru');
    assert.equal(cityOf(c('Gurgaon')), 'Gurugram');
    assert.equal(cityOf(c('Bombay, MH')), 'Mumbai');
  });
});

suite('rulesPlan', () => {
  test('2-3 distinct queries: title, top skill role word, no entry variant for experienced', () => {
    const p = rulesPlan(buildProfileDigest(records, roles, contact), roles, contact);
    assert.deepEqual(p.queries.map((x) => x.q), ['Backend Engineer Pune', 'Go developer Pune']);
    assert.equal(p.seniority, 'senior');
  });
  test('non-programming skill is "<skill> <city>"', () => {
    const p = rulesPlan(buildProfileDigest([skill('Tableau')], roles, contact), roles, contact);
    assert.equal(p.queries[1].q, 'Tableau Pune');
  });
  test('fresher: entry-level variant, years-based seniority', () => {
    const fresher = [role('1', 'ML Intern', '2026-01', '2026-06')];
    const ct = c('Hyderabad, India');
    const p = rulesPlan(buildProfileDigest([skill('Python')], fresher, ct), fresher, ct);
    assert.deepEqual(p.queries.map((x) => x.q), ['ML Intern Hyderabad', 'Python developer Hyderabad', 'ML engineer fresher Hyderabad']);
    assert.ok(p.seniority === 'intern' || p.seniority === 'entry');
    const one = [role('1', 'Data Analyst', '2025-06', 'present')];
    assert.ok(rulesPlan('', one, ct).queries.some((x) => /Data Analyst fresher/.test(x.q)));
  });
  test('no entry variant for 4 years of experience; seniority mid', () => {
    const r = [role('1', 'Full Stack Developer', '2022-06', 'present')];
    const p = rulesPlan(buildProfileDigest([skill('React')], r, c('Bangalore')), r, c('Bangalore'));
    assert.ok(!p.queries.some((x) => /fresher/.test(x.q)));
    assert.equal(p.queries[0].q, 'Full Stack Developer Bengaluru');
    assert.ok(['mid', 'senior'].includes(p.seniority));
  });
  test('queries are distinct and capped at 3', () => {
    const p = rulesPlan(buildProfileDigest([skill('Python')], [role('1', 'Python developer', '2026-01', 'present')], contact), [role('1', 'Python developer', '2026-01', 'present')], contact);
    assert.equal(new Set(p.queries.map((x) => x.q.toLowerCase())).size, p.queries.length);
    assert.ok(p.queries.length <= 3);
  });
});

const digest = buildProfileDigest(records, roles, contact);
const throwing = async (): Promise<never> => {
  throw new Error('boom');
};
const q = (s: string) => ({ q: s, why: '' });
const plan = (queries: ReturnType<typeof q>[], location = '') => async () => ({
  data: { queries, location, seniority: 'mid' as const, rationale: 'r' },
});

await testAsync('planSearch falls back to rules when the generator throws', async () => {
  const p = await planSearch({ digest, roles, contact }, throwing);
  assert.deepEqual(p.queries.map((x) => x.q), ['Backend Engineer Pune', 'Go developer Pune']);
  assert.equal(p.location, 'Pune');
});
await testAsync('planSearch defaults city and role with an empty profile', async () => {
  const p = await planSearch({ digest: '', roles: [], contact: { fullName: '', email: '' } }, throwing);
  assert.deepEqual(p.queries.map((x) => x.q), ['software engineer Bengaluru']);
});
await testAsync('planSearch uses model output, deduped and capped at 3', async () => {
  const p = await planSearch({ digest, roles, contact }, plan([q('Backend Pune'), q('backend pune'), q('Engineer Pune')]));
  assert.deepEqual(p.queries.map((x) => x.q), ['Backend Pune', 'Engineer Pune']);
  assert.equal(p.location, 'Pune');
});
await testAsync('planSearch drops hallucinated queries and falls back when none remain', async () => {
  const mixed = await planSearch({ digest, roles, contact }, plan([q('Astronaut Pune'), q('Backend Engineer Pune')]));
  assert.deepEqual(mixed.queries.map((x) => x.q), ['Backend Engineer Pune']);
  const none = await planSearch({ digest, roles, contact }, plan([q('Astronaut Pune'), q('Chef Mars')]));
  assert.deepEqual(none.queries.map((x) => x.q), ['Backend Engineer Pune', 'Go developer Pune']);
});
await testAsync('planSearch normalises the model location (Bangalore -> Bengaluru)', async () => {
  const bl = c('Bangalore');
  const d = buildProfileDigest(records, roles, bl);
  const p = await planSearch({ digest: d, roles, contact: bl }, plan([q('Backend Engineer Bangalore')], 'Bangalore'));
  assert.equal(p.location, 'Bengaluru');
});

report();
