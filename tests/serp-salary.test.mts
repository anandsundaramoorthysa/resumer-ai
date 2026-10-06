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
  test('India shorthand: 10L, ₹8L - ₹12L, crore', () => {
    assert.deepEqual(parseSalaryLpa('CTC 10L for this role'), { min: 10, max: 10, source: 'regex' });
    assert.deepEqual(parseSalaryLpa('Salary ₹8L - ₹12L'), { min: 8, max: 12, source: 'regex' });
    assert.deepEqual(parseSalaryLpa('Package ₹1.2 Cr'), { min: 120, max: 120, source: 'regex' });
  });
  test('stipend per month without a currency symbol is annualised', () => {
    assert.deepEqual(parseSalaryLpa('stipend: 15000 per month'), { min: 1.8, max: 1.8, source: 'regex' });
  });
  test('no salary cue => none', () => {
    assert.equal(parseSalaryLpa('We serve 50 lakh customers across India').source, 'none');
    assert.equal(parseSalaryLpa('Turnover Rs 5 lakh crore').source, 'none');
    assert.equal(parseSalaryLpa('Join our team of 10L users').source, 'none');
    assert.equal(parseSalaryLpa('Shift 15000 per month of logs').source, 'none');
  });
  test('over 200 LPA is a misparse', () => {
    assert.equal(parseSalaryLpa('Package ₹3 Cr').source, 'none');
  });
  test('foreign currency and hourly rates are rejected', () => {
    assert.equal(parseSalaryLpa('Salary $120,000 per annum').source, 'none');
    assert.equal(parseSalaryLpa('Pay 80000 USD per annum salary').source, 'none');
    assert.equal(parseSalaryLpa('Salary €60,000 per annum').source, 'none');
    assert.equal(parseSalaryLpa('Salary £50,000 per annum').source, 'none');
    assert.equal(parseSalaryLpa('Salary ₹500 per hour').source, 'none');
    assert.equal(parseSalaryLpa('Compensation 15 LPA per hour').source, 'none');
  });
  test('no salary at all', () => {
    assert.deepEqual(parseSalaryLpa('2-4 years of experience, join in 3 months'), { min: 0, max: 0, source: 'none' });
  });
});
