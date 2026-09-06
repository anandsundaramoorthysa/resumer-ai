/**
 * Role identity — every case below is a real row pair observed in the live profile,
 * which had grown to 16 rows for 10 actual jobs.
 */

import {
  dedupeRoles,
  normalizeCompany,
  normalizeTitle,
  roleIdentity,
  splitMergedTitles,
  mergeRoles,
} from '../lib/sync/roles';
import { suite, test, assert } from './harness.mjs';

const same = (a: [string, string], b: [string, string]) =>
  roleIdentity(a[0], a[1]) === roleIdentity(b[0], b[1]);

suite('role identity', () => {
  test('company spelled with different spacing is one company', () => {
    assert(
      normalizeCompany('D2R AI Labs') === normalizeCompany('D2RAI Labs'),
      'D2R AI Labs and D2RAI Labs are the same employer',
    );
  });

  test('company cased differently is one company', () => {
    assert(normalizeCompany('DiffuseAi') === normalizeCompany('DiffuseAI'), 'case only');
  });

  test('a parent company appended does not create a second employer', () => {
    assert(
      normalizeCompany('Sparks AI') ===
        normalizeCompany('Sparks AI / Welbuilt AI Solutions Pvt. Ltd.'),
      'the first name is the stable one',
    );
  });

  test('self-published and self-employed suffixes are noise', () => {
    assert(normalizeCompany('Medium') === normalizeCompany('Medium (Self-Published)'), 'Medium');
  });

  test('a title qualifier does not create a second job', () => {
    assert(
      normalizeTitle('Flutter Developer (Paid Intern)') ===
        normalizeTitle('Flutter Developer Intern'),
      'the same internship written two ways',
    );
  });

  test('genuinely different jobs at one company stay separate', () => {
    assert(
      !same(['DiffuseAI', 'Project Manager'], ['DiffuseAI', 'Full Stack Developer']),
      'these are three real roles, not one',
    );
    assert(
      !same(['DiffuseAI', 'Project Manager'], ['DiffuseAI', 'Artificial Intelligence Intern']),
      'and must never be collapsed',
    );
  });

  test('self-employment described several ways is one arrangement', () => {
    assert(
      normalizeCompany('Self-Employed') === normalizeCompany('Freelancer'),
      'the live profile carried both for the same work',
    );
    assert(
      normalizeCompany('Independent') === normalizeCompany('Self-Employed'),
      'and independent means the same thing',
    );
    assert(
      normalizeCompany('Freelancer') !== normalizeCompany('Corizo'),
      'but a real employer is still a real employer',
    );
  });

  test('different employers never collapse', () => {
    assert(!same(['Corizo', 'Developer'], ['Sparks AI', 'Developer']), 'distinct employers');
  });

  test('a merged title splits into its real roles', () => {
    const parts = splitMergedTitles(
      'Artificial Intelligence Intern / Full Stack Developer / Project Manager',
    );
    assert(parts.length === 3, `expected 3 roles, got ${parts.length}`);
    assert(parts[0] === 'Artificial Intelligence Intern', 'first role preserved');
  });

  test('an ordinary title is left alone', () => {
    assert(splitMergedTitles('Full Stack Developer').length === 1, 'no false split');
  });

  test('merging keeps the fuller telling and any real date', () => {
    const merged = mergeRoles(
      { title: 'Writer', company: 'Medium', startDate: '', endDate: 'present' },
      {
        title: 'Writer',
        company: 'Medium (Self-Published)',
        startDate: '2024-11',
        endDate: 'present',
      },
    );
    assert(merged.company === 'Medium (Self-Published)', 'fuller company name wins');
    assert(merged.startDate === '2024-11', 'a real date beats an empty one');
  });

  test('the live 16-row profile collapses to its real jobs', () => {
    const observed = [
      { title: 'Flutter Developer (Paid Intern)', company: 'Corizo', startDate: '2024-04', endDate: '2024-06' },
      { title: 'Flutter Developer Intern', company: 'Corizo', startDate: '2024-04', endDate: '2024-06' },
      { title: 'Product & Automation Engineering Intern', company: 'D2R AI Labs', startDate: '2026-04', endDate: '2026-05' },
      { title: 'Product & Automation Engineering Intern', company: 'D2RAI Labs', startDate: '2026-04', endDate: '2026-05' },
      { title: 'Artificial Intelligence Intern / Full Stack Developer / Project Manager', company: 'DiffuseAI', startDate: '', endDate: 'present' },
      { title: 'Project Manager', company: 'DiffuseAi', startDate: '2025-03', endDate: '2025-12' },
      { title: 'Full Stack Developer', company: 'DiffuseAi', startDate: '2024-10', endDate: '2025-10' },
      { title: 'Artificial Intelligence Intern', company: 'DiffuseAi', startDate: '2024-08', endDate: '2024-10' },
      { title: 'Writer', company: 'Medium', startDate: '2024-11', endDate: 'present' },
      { title: 'Writer', company: 'Medium (Self-Published)', startDate: '2024-11', endDate: 'present' },
      { title: 'Business Development Manager', company: 'Sparks AI', startDate: '2025-08', endDate: '2025-12' },
      { title: 'Business Development Manager', company: 'Sparks AI / Welbuilt AI Solutions Pvt. Ltd.', startDate: '2025-08', endDate: '2025-12' },
      { title: 'Builder', company: 'Future Free', startDate: '2026-02', endDate: 'present' },
      { title: 'Tech Research Intern', company: 'To-Let Globe', startDate: '2024-07', endDate: '2024-09' },
    ];

    // Nine real jobs hide in these fourteen rows: one each at Corizo, D2R AI Labs,
    // Medium, Sparks AI, Future Free and To-Let Globe, plus three genuinely distinct
    // ones at DiffuseAI.
    const deduped = dedupeRoles(observed);
    assert(
      deduped.length === 9,
      `expected 9 real jobs from these 14 rows, got ${deduped.length}: ${deduped
        .map((r) => `${r.company}/${r.title}`)
        .join(', ')}`,
    );

    // The merged row must land on the three real DiffuseAI jobs, not add a fourth.
    const diffuse = deduped.filter((r) => normalizeCompany(r.company) === normalizeCompany('DiffuseAI'));
    assert(diffuse.length === 3, `DiffuseAI should have 3 roles, got ${diffuse.length}`);

    // And the empty start date must not survive onto the merged row.
    assert(
      diffuse.every((r) => r.startDate.trim().length > 0),
      'no role should be left without a start date',
    );
  });
});
