/** Partial JSONB records (importer, old syncs) must not crash ranking. */
import { suite, test, assert } from './harness.mjs';
import { rankRecords, recordText } from '../lib/retrieval/rank';
import { heldSkills, rankPostings } from '../lib/radar/ranker';
import type { JobRequirement, ProfileRecord, RoleRecord } from '../lib/types';
import type { Posting } from '../lib/serp/types';

const base = { userId: 'u', source: 'ai-import' as const, flaggedForRemoval: false, reviewState: 'approved' as const, createdAt: new Date(), updatedAt: new Date() };
const partial = (o: Record<string, unknown>) => ({ ...base, tags: [], contentHash: String(o.id), ...o }) as unknown as ProfileRecord;

const records: ProfileRecord[] = [
  partial({ id: 'p1', type: 'project', name: 'Dashboard', description: 'Python dashboard' }), // no stack / impactMetrics / tags
  { ...partial({ id: 'p2', type: 'project', name: 'Bare' }), tags: undefined } as unknown as ProfileRecord,
  partial({ id: 's1', type: 'skill', category: 'tool' }), // no name
  partial({ id: 'b1', type: 'experience-bullet', roleId: 'r1' }), // no text / action
  partial({ id: 's2', type: 'skill', name: 'Python', category: 'language' }),
];
const roles: RoleRecord[] = [
  { id: 'r1', userId: 'u', title: 'Data Analyst', company: 'Acme', startDate: '2022-01', endDate: 'present', source: 'manual', contentHash: 'r1', reviewState: 'approved' },
];
const job = {
  roleTitle: 'Data Analyst', company: 'X', seniority: 'mid', category: 'data', atsKeywords: ['python', 'sql'],
  requiredSkills: ['python'], preferredSkills: [], responsibilities: [], flags: [], confidence: 1,
} as unknown as JobRequirement;

suite('partial records do not crash ranking', () => {
  test('recordText tolerates missing fields', () => {
    for (const r of records) assert.equal(typeof recordText(r), 'string');
  });
  test('rankRecords', () => {
    const out = rankRecords(records, job);
    assert.ok(out.ranked.length + out.excluded.length >= 1);
  });
  test('heldSkills', () => {
    assert.ok(heldSkills(records, roles).has('python'));
  });
  test('rankPostings', () => {
    const p = {
      key: 'k', title: 'Data Analyst', company: 'C', location: 'Chennai', via: '', description: 'Python and SQL required. '.repeat(10),
      applyLinks: [], postedAt: '', scheduleType: '', salaryLpa: { min: 0, max: 0, source: 'none' }, highlights: [], serpJobId: '', fromQuery: 0,
    } as Posting;
    const out = rankPostings([p], { records, roles, contact: { fullName: 'A', email: 'a@x.com', location: 'Chennai' } as never });
    assert.equal(out[0].key, 'k');
    assert.ok(out[0].matched.includes('python'));
  });
});
