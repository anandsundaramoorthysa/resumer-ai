/** Salary parsing for Indian postings: LPA, lakhs, monthly, CTC, and the 1-200 LPA guard. */

import { assert, suite, test } from './harness.mjs';
import { parseSalaryLpa } from '@/lib/serp/salary';

suite('parseSalaryLpa', () => {
  test('LPA range', () => {
    assert.deepEqual(parseSalaryLpa('Salary 12-18 LPA based on experience'), { min: 12, max: 18, source: 'regex' });
  });
  test('range with unit on the first number and an en dash', () => {
    assert.deepEqual(parseSalaryLpa('₹6 LPA – ₹10 LPA'), { min: 6, max: 10, source: 'regex' });
  });
  test('lakhs per annum, "to" range', () => {
    assert.deepEqual(parseSalaryLpa('18 to 26 lakhs per annum'), { min: 18, max: 26, source: 'regex' });
  });
  test('single LPA figure', () => {
    assert.deepEqual(parseSalaryLpa('up to 9.5 lpa'), { min: 9.5, max: 9.5, source: 'regex' });
  });
  test('monthly rupees x12 / 1e5', () => {
    assert.deepEqual(parseSalaryLpa('₹50,000 - ₹70,000 per month'), { min: 6, max: 8.4, source: 'regex' });
    assert.deepEqual(parseSalaryLpa('Stipend ₹25,000 per month'), { min: 3, max: 3, source: 'regex' });
  });
  test('CTC as a bare amount', () => {
    assert.deepEqual(parseSalaryLpa('CTC: 20,00,000 - 30,00,000'), { min: 20, max: 30, source: 'regex' });
  });
  test('per annum amounts', () => {
    assert.deepEqual(parseSalaryLpa('₹8,00,000 per annum'), { min: 8, max: 8, source: 'regex' });
  });
  test("SerpApi's own field wins and is labelled serp", () => {
    assert.deepEqual(parseSalaryLpa('12-18 LPA', '₹6–10 LPA'), { min: 6, max: 10, source: 'serp' });
  });
  test('unparseable serp field falls back to the text', () => {
    assert.equal(parseSalaryLpa('7-9 LPA', 'competitive').source, 'regex');
  });
  test('rejects outside 1-200 LPA', () => {
    assert.equal(parseSalaryLpa('0.5 LPA').source, 'none');
    assert.equal(parseSalaryLpa('500 LPA').source, 'none');
    assert.equal(parseSalaryLpa('₹5 per month').source, 'none');
  });
  test('no salary at all', () => {
    assert.deepEqual(parseSalaryLpa('2-4 years of experience, join in 3 months'), { min: 0, max: 0, source: 'none' });
  });
});
