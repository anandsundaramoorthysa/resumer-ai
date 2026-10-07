/** redactContact: obfuscation, other scripts and phone shapes, and what must NOT be touched. */
import { assert, suite, test } from './harness.mjs';
import { redactContact } from '../lib/ai/redact';

const MUST_REDACT: Array<[string, string]> = [
  ['mail john@gmail.com now', '[email]'],
  ['john at gmail dot com', '[email]'],
  ['john [at] gmail [dot] com', '[email]'],
  ['john(at)gmail.com', '[email]'],
  ['john (at) gmail (dot) co (dot) in', '[email]'],
  ['jane＠example.com', '[email]'],
  ['john@gmail .com', '[email]'],
  ['a.b+c@example.co.in', '[email]'],
  ['+91 98765 43210', '[phone]'],
  ['+91-98765-43210', '[phone]'],
  ['(+91) 98765 43210', '[phone]'],
  ['0091 98765 43210', '[phone]'],
  ['9876543210', '[phone]'],
  ['098765 43210', '[phone]'],
  ['ph 9876543210x12', '[phone]'],
  ['+91 9876543210 ext. 204', '[phone]'],
  ['९८७६५ ४३२१०', '[phone]'],
  ['+९१ ९८७६५४३२१०', '[phone]'],
  ['９８７６５４３２１０', '[phone]'],
  ['+１ ４１５ ５５５ ０１００', '[phone]'],
  ['(555) 123-4567', '[phone]'],
  ['+1 415 555 0100', '[phone]'],
  ['https://jane.github.io/portfolio', '[profile-url]'],
  ['jane-doe.github.io', '[profile-url]'],
  ['https://www.linkedin.com/in/jane-doe/', '[profile-url]'],
  ['linkedin.com/in/jane', '[profile-url]'],
  ['github.com/janedoe', '[profile-url]'],
  ['https://x.com/janedoe', '[profile-url]'],
];

const MUST_KEEP = [
  'Worked 2024-2026 on payments',
  '2020-2022 2023 roles',
  'Raised ₹10,00,000 in funding',
  'Salary 1,00,00,000 per year',
  'Built with v1.2.3 of the SDK',
  'Node 20.19 and TypeScript 5.9.2',
  'Joined at stripe.com in 2020',
  'Meet at 5 dot sharp',
  'Reached 98.5% accuracy over 1200 requests',
  'Order 12345 shipped 2026-10-08',
  'Python 3.12.4, Django 5.0.1',
  'GPA 8.7/10, rank 120',
  'Version 1.2.3.4.5.6.7.8.9.10',
  'Increased revenue by 120% in 18 months',
  'Visited box.com/features today',
  'Team of 10-15 engineers, 100000 users',
  'Pune, India 411001',
];

suite('redactContact: must redact', () => {
  for (const [input, token] of MUST_REDACT) {
    test(input, () => {
      const out = redactContact(input);
      assert(out.includes(token), `${input} -> ${out}`);
      assert(!/[\d०-९]{6,}|@|\bdot\b/.test(out.replace(/\d{4}/g, '')) || token === '[profile-url]', `${input} -> ${out}`);
    });
  }
});

suite('redactContact: must keep', () => {
  for (const input of MUST_KEEP) test(input, () => assert.equal(redactContact(input), input));
});

suite('redactContact: caps and options', () => {
  test('a run of more than 15 digits is not a phone number', () => {
    assert.equal(redactContact('id 1234567890123456'), 'id 1234567890123456');
  });
  test('profileUrls:false leaves profile links', () => {
    assert.equal(redactContact('linkedin.com/in/jane', { profileUrls: false }), 'linkedin.com/in/jane');
  });
  test('the phone redaction swallows the extension', () => {
    assert.equal(redactContact('ph 9876543210x12 ok'), 'ph [phone] ok');
  });
});
