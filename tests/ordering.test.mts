/**
 * What order each profile section is shown in — lib/profile/ordering.ts.
 *
 * The bug this pins: there was no order at all. Rows came back in the order they were
 * written, so Experience read oldest job first and a school certificate sat above a
 * master's degree. The cases below are the ones that made it visible, plus the two that
 * are easy to get backwards: an entry with no date must sort last rather than first, and
 * the sections that are not a history must not be sorted as one.
 */

import { suite, test, assert } from './harness.mjs';
import { dateRank, orderRecords } from '../lib/profile/ordering';

const rec = (type: string, data: Record<string, unknown>, updatedAt = '2024-01-01') => ({
  type,
  data,
  updatedAt: new Date(updatedAt),
});

const titles = (list: Array<{ data: Record<string, unknown> }>, field = 'title') =>
  list.map((r) => String(r.data[field]));

suite('reading a date for sorting', () => {
  test('a year and month beats a bare year in the same year', () => {
    assert.ok(dateRank('2024-09')! > dateRank('2024-01')!, 'later month is higher');
    assert.ok(dateRank('2024')! > dateRank('2024-01')!, 'a bare year sits mid-year');
    assert.ok(dateRank('2024')! < dateRank('2024-12')!, 'and below December');
  });

  test('still happening beats every finished date', () => {
    assert.ok(dateRank('present')! > dateRank('2026-12')!, 'present is the top');
    assert.ok(dateRank('Present')! === dateRank('current'), 'however it is written');
  });

  test('what cannot be read is not a date', () => {
    for (const v of ['', 'sometime', 'last summer', null, undefined]) assert.equal(dateRank(v), null, String(v));
  });

  test('a date written in prose is still read', () => {
    assert.ok(dateRank('Issued Mar 2023')! > 0, 'a year inside a sentence counts');
  });
});

suite('each section in the order its kind is read', () => {
  test('qualifications run newest first, so a degree sits above school', () => {
    const ordered = orderRecords('education', [
      rec('education', { credential: 'HSC', endDate: '2021' }),
      rec('education', { credential: 'M.Sc', endDate: '2027' }),
      rec('education', { credential: 'B.Sc', endDate: '2025' }),
    ]);
    assert.deepEqual(titles(ordered, 'credential'), ['M.Sc', 'B.Sc', 'HSC']);
  });

  test('certifications run newest first on the date they were issued', () => {
    const ordered = orderRecords('certification', [
      rec('certification', { name: 'Old', issuedDate: '2022-01' }),
      rec('certification', { name: 'New', issuedDate: '2025-06' }),
    ]);
    assert.deepEqual(titles(ordered, 'name'), ['New', 'Old']);
  });

  test('an entry with no date sorts last, because no date is not today', () => {
    const ordered = orderRecords('award', [
      rec('award', { title: 'Undated' }),
      rec('award', { title: 'Dated 2023', date: '2023' }),
    ]);
    assert.deepEqual(titles(ordered), ['Dated 2023', 'Undated']);
  });

  test('skills group by category and read alphabetically inside it', () => {
    const ordered = orderRecords('skill', [
      rec('skill', { name: 'Docker', category: 'tool' }),
      rec('skill', { name: 'Python', category: 'language' }),
      rec('skill', { name: 'Flask', category: 'framework' }),
      rec('skill', { name: 'Airflow', category: 'tool' }),
    ]);
    assert.deepEqual(titles(ordered, 'name'), ['Python', 'Flask', 'Airflow', 'Docker']);
  });

  test('languages and interests are alphabetical, not chronological', () => {
    const ordered = orderRecords('language', [rec('language', { name: 'Tamil' }), rec('language', { name: 'English' })]);
    assert.deepEqual(titles(ordered, 'name'), ['English', 'Tamil']);
  });

  test('projects carry no date, so the one worked on most recently leads', () => {
    const ordered = orderRecords('project', [
      rec('project', { name: 'Older' }, '2024-01-01'),
      rec('project', { name: 'Newer' }, '2026-09-01'),
    ]);
    assert.deepEqual(titles(ordered, 'name'), ['Newer', 'Older']);
  });

  test('a type this module has not met keeps the order it arrived in', () => {
    const list = [rec('mystery', { name: 'b' }), rec('mystery', { name: 'a' })];
    assert.deepEqual(titles(orderRecords('mystery', list), 'name'), ['b', 'a']);
  });
});
