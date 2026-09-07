/**
 * The hand-written bullet path — AUDIT.md #2.
 *
 * The live profile had six bullets and an evidence sub-score of 0%, which is 30% of the
 * total. These assertions pin the shape that changes that.
 */

import {
  assessBullet,
  composeBulletText,
  hasMetric,
  wordCount,
  MAX_BULLET_WORDS,
  BULLET_EXAMPLE,
} from '../lib/profile/bullet';
import { findProfileGaps, hasMeasurableOutcome } from '../lib/profile/gaps';
import type { ProfileRecord, RoleRecord } from '../lib/types';
import { suite, test, assert } from './harness.mjs';

const role = (id: string, title: string, company: string) =>
  ({ id, userId: 'u', title, company, startDate: '2024-01', endDate: 'present',
     source: 'github-sync', contentHash: id }) as RoleRecord;

const bullet = (roleId: string) =>
  ({ id: `b-${roleId}`, userId: 'u', type: 'experience-bullet', roleId,
     text: 'x', action: 'x', tags: [], contentHash: `h-${roleId}`,
     source: 'manual', flaggedForRemoval: false,
     createdAt: new Date(), updatedAt: new Date() }) as unknown as ProfileRecord;

const project = (id: string, name: string, impactMetrics: string[]) =>
  ({ id, userId: 'u', type: 'project', name, description: '', stack: [], links: [],
     impactMetrics, tags: [], contentHash: id, source: 'manual',
     flaggedForRemoval: false, createdAt: new Date(), updatedAt: new Date() }) as unknown as ProfileRecord;

suite('bullet composition', () => {
  test('the three fields compose into one readable line', () => {
    const text = composeBulletText(BULLET_EXAMPLE);
    assert(text.includes(BULLET_EXAMPLE.action), 'action present');
    assert(text.includes('200K'), 'scale present');
    assert(text.includes('40%'), 'outcome present');
    assert(!text.includes('  '), 'no doubled spacing from an empty field');
  });

  test('missing optional fields do not leave stray punctuation', () => {
    const text = composeBulletText({ action: 'Shipped the billing rewrite' });
    assert(text === text.trim(), 'no leading or trailing space');
    assert(!/[,;]\s*$/.test(text), `no dangling separator: ${JSON.stringify(text)}`);
  });

  test('an action alone still composes', () => {
    assert(composeBulletText({ action: 'Ran the migration' }).length > 0, 'not empty');
  });
});

suite('bullet grading', () => {
  test('a figure is recognised in any of the usual forms', () => {
    assert(hasMetric('cut latency 40%'), 'percentage');
    assert(hasMetric('served 200K requests'), 'abbreviated thousand');
    assert(hasMetric('across 4 client sites'), 'plain integer');
    assert(!hasMetric('made things considerably faster'), 'no figure at all');
  });

  test('the worked example passes every check', () => {
    const a = assessBullet(BULLET_EXAMPLE);
    assert(a.strong, `example should be strong: ${JSON.stringify(a.checks.filter((c) => !c.ok))}`);
  });

  test('an action-only bullet fails scale, outcome and metric', () => {
    const a = assessBullet({ action: 'Responsible for database optimization' });
    const failed = a.checks.filter((c) => !c.ok).map((c) => c.id);
    assert(failed.includes('scale'), 'scale flagged');
    assert(failed.includes('outcome'), 'outcome flagged');
    assert(failed.includes('metric'), 'metric flagged');
    assert(!a.strong, 'and it is not strong');
  });

  test('an overlong bullet is flagged on length but still composes', () => {
    const long = { action: 'Did the thing '.repeat(12).trim() };
    const a = assessBullet(long);
    assert(wordCount(a.text) > MAX_BULLET_WORDS, 'genuinely over the ceiling');
    assert(!a.checks.find((c) => c.id === 'length')!.ok, 'length flagged');
    assert(a.text.length > 0, 'and the text is still produced — grading never blocks saving');
  });
});

suite('profile gaps', () => {
  test('a project with no figure in its metrics is not measurable', () => {
    assert(!hasMeasurableOutcome([]), 'nothing recorded');
    assert(!hasMeasurableOutcome(['Improved the experience']), 'prose without a figure');
    assert(hasMeasurableOutcome(['Cut load time 40%']), 'a real outcome');
  });

  test('roles without bullets are reported, roles with them are not', () => {
    const roles = [role('r1', 'Engineer', 'Acme'), role('r2', 'Writer', 'Medium')];
    const gaps = findProfileGaps(roles, [bullet('r1')]);
    assert(gaps.rolesWithoutBullets.length === 1, 'exactly one gap');
    assert(gaps.rolesWithoutBullets[0].roleId === 'r2', 'and it is the empty role');
    assert(gaps.totalRoles === 2, 'total counted');
  });

  test('projects lacking a measurable outcome are reported', () => {
    const gaps = findProfileGaps(
      [],
      [project('p1', 'Portfolio', []), project('p2', 'Pipeline', ['Cut runtime 30%'])],
    );
    assert(gaps.projectsWithoutMetrics.length === 1, 'exactly one');
    assert(gaps.projectsWithoutMetrics[0].name === 'Portfolio', 'the one with nothing recorded');
  });

  test('a complete profile reports no headline at all', () => {
    const gaps = findProfileGaps(
      [role('r1', 'Engineer', 'Acme')],
      [bullet('r1'), project('p1', 'Pipeline', ['Cut runtime 30%'])],
    );
    assert(gaps.headline === null, `expected no headline, got: ${gaps.headline}`);
  });

  test('a flagged bullet does not count as covering its role', () => {
    const flaggedBullet = { ...(bullet('r1') as object), flaggedForRemoval: true } as ProfileRecord;
    const gaps = findProfileGaps([role('r1', 'Engineer', 'Acme')], [flaggedBullet]);
    assert(
      gaps.rolesWithoutBullets.length === 1,
      'a bullet awaiting removal cannot be the reason a role looks covered',
    );
  });
});
