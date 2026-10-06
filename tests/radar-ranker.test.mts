import { readFileSync } from 'node:fs';
import { suite, test, assert } from './harness.mjs';
import { rankPostings } from '../lib/radar/ranker';
import type { Posting } from '../lib/serp/types';
import type { ProfileRecord, RoleRecord } from '../lib/types';

const base = { userId: 'u', source: 'manual' as const, flaggedForRemoval: false, reviewState: 'approved' as const, createdAt: new Date(), updatedAt: new Date() };
const skill = (id: string, name: string): ProfileRecord =>
  ({ ...base, id, type: 'skill', name, category: 'language', tags: [], contentHash: id }) as ProfileRecord;
const records = [skill('1', 'Python'), skill('2', 'SQL'), skill('3', 'React')];
const roles: RoleRecord[] = [
  { id: 'w', userId: 'u', title: 'Data Analyst', company: 'Acme', startDate: '2022-01', endDate: 'present', source: 'manual', contentHash: 'w', reviewState: 'approved' },
];
const contact = { fullName: 'A', email: 'a@x.com', location: 'Chennai, India' };

const posting = (key: string, title: string, description: string): Posting => ({
  key, title, company: key, location: 'Chennai', via: '', description, applyLinks: [], postedAt: '',
  scheduleType: '', salaryLpa: { min: 0, max: 0, source: 'none' }, highlights: [], serpJobId: '', fromQuery: 0,
});
const LONG = ' We are hiring and you will work with a great team on many interesting problems every day. '.repeat(3);

suite('rankPostings', () => {
  const good = posting('b-good', 'Data Analyst', `Python and SQL required, React nice.${LONG}`);
  const bad = posting('a-bad', 'Data Analyst', `Kubernetes, Terraform, Java and Kafka.${LONG}`);
  const ranked = rankPostings([bad, good], { records, roles, contact });

  test('matching posting outranks non-matching', () => {
    assert.equal(ranked[0].key, 'b-good');
    assert.ok(ranked[0].score > ranked[1].score);
  });
  test('matched and missing are correct', () => {
    assert.deepEqual([...ranked[0].matched].sort(), ['python', 'react', 'sql']);
    assert.deepEqual(ranked[0].missing, []);
    assert.ok(ranked[1].missing.includes('kubernetes'));
    assert.deepEqual(ranked[1].matched, []);
  });
  test('empty description scores lower and says so', () => {
    const r = rankPostings([posting('e', 'Data Analyst', '')], { records, roles, contact })[0];
    assert.ok(r.score < ranked[0].score);
    assert.ok(/short description/i.test(r.reason));
  });
  test('topK and stable tie-break by key', () => {
    const ps = ['z', 'm', 'a'].map((k) => posting(k, 'Role', ''));
    const r = rankPostings(ps, { records, roles, contact }, 2);
    assert.deepEqual(r.map((x) => x.key), ['a', 'm']);
  });
  test('empty input', () => {
    assert.deepEqual(rankPostings([], { records: [], roles: [], contact }), []);
  });
  test('ranker module does not import the model layer', () => {
    const src = readFileSync(new URL('../lib/radar/ranker.ts', import.meta.url), 'utf8');
    assert.ok(!/from '[^']*\/ai\//.test(src));
  });
});
