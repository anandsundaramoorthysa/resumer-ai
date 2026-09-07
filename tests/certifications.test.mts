/**
 * Certification identity.
 *
 * Every case below is drawn from the live profile's 28 certificates. That matters more
 * here than for roles or education, because certificate names are ordinary English and a
 * normaliser that is one word too aggressive merges two real courses into one. The
 * negative cases are the point of this file: they are the pairs the rules were tuned
 * against, and each one names a certificate the user actually holds.
 */

import {
  certificationHashParts,
  certificationIdentity,
  dedupeCertifications,
  mergeCertifications,
  normalizeCertName,
  normalizeIssuer,
} from '../lib/sync/certifications';
import { suite, test, assert } from './harness.mjs';

const same = (a: [string, string], b: [string, string]) =>
  certificationIdentity(a[0], a[1]) === certificationIdentity(b[0], b[1]);

suite('certification identity', () => {
  test('the live duplicate collapses — a comma and the word "in"', () => {
    assert(
      same(['Nanodegree in Agentic AI', 'Udacity'], ['Nanodegree, Agentic AI', 'Udacity']),
      'these two rows are one certificate, and were two only because of punctuation',
    );
  });

  test('an ampersand and the word "and" are the same word', () => {
    assert(
      same(
        ['Computer Network & Internet Security', 'Infosys Springboard'],
        ['Computer Network and Internet Security', 'Infosys Springboard'],
      ),
      'one certificate however the conjunction was typed',
    );
  });

  test('a dash is typography, not content', () => {
    assert(
      same(['Bootstrap 5 — The Complete Guide', 'Udemy'], ['Bootstrap 5 - The Complete Guide', 'Udemy']),
      'em dash and hyphen',
    );
    assert(
      same(['Python Programming - 01', 'Infosys Springboard'], ['Python Programming 01', 'Infosys Springboard']),
      'and with the dash simply absent',
    );
  });

  test('case and spacing do not make a second certificate', () => {
    assert(same(['Java (Basic)', 'HackerRank'], ['java  (basic)', 'HackerRank']), 'case and spacing');
  });
});

suite('certificates that must never merge', () => {
  test('two "Introduction to" courses on different subjects stay apart', () => {
    assert(
      !same(
        ['Introduction to Data Science', 'Infosys Springboard'],
        ['Introduction to Digital Marketing', 'Great Learning'],
      ),
      'the subject is the identity, and dropping "introduction" would thin that margin',
    );
    assert(
      !same(
        ['Introduction to Natural Language Processing', 'Infosys Springboard'],
        ['Introduction to Model Context Protocol', 'Anthropic'],
      ),
      'both start identically and are different courses',
    );
  });

  test('the same "(Basic)" suffix on different languages stays apart', () => {
    assert(!same(['CSS (Basic)', 'HackerRank'], ['Java (Basic)', 'HackerRank']), 'CSS is not Java');
  });

  test('similar programming courses stay apart', () => {
    assert(
      !same(['Python Programming - 01', 'Infosys Springboard'], ['C Programming 101', 'Infosys Springboard']),
      'different language and different number',
    );
  });

  test('two workshops sharing "Data Science" stay apart', () => {
    assert(
      !same(
        ['Workshop on Python for Data Science', "St. Joseph's College (Autonomous)"],
        ['Workshop on AI & ML with Data Science (IIT Madras)', 'Ethical Edufabrica'],
      ),
      'the connectives go, the subjects remain, and the subjects differ',
    );
  });

  test('the same course name from two issuers is two certificates', () => {
    assert(
      !same(['Introduction to Data Science', 'Infosys Springboard'], ['Introduction to Data Science', 'Coursera']),
      'issuer is part of the identity — reconcile keyed on the name alone and would have merged these',
    );
  });
});

suite('issuer normalisation', () => {
  test('the delivery platform is dropped, the awarding body is kept', () => {
    assert(normalizeIssuer('Meta (Coursera)') === normalizeIssuer('Meta'), 'Meta, however delivered');
    assert(
      normalizeIssuer('UC San Diego (Coursera)') === normalizeIssuer('UC San Diego'),
      'and the university is the issuer',
    );
  });

  test('two institutions sharing a platform do not collapse onto it', () => {
    assert(
      normalizeIssuer('IIT Madras (NPTEL)') !== normalizeIssuer('IIT Kharagpur (NPTEL)'),
      'NPTEL delivers for both; they are different institutes',
    );
  });

  test('a joint issuer written two ways is one issuer', () => {
    assert(
      normalizeIssuer('Microsoft & LinkedIn') === normalizeIssuer('Microsoft and LinkedIn'),
      'the conjunction is not identity',
    );
  });
});

suite('merging and deduping', () => {
  test('the fuller telling survives, and so does any real date', () => {
    const merged = mergeCertifications(
      { name: 'Nanodegree, Agentic AI', issuer: 'Udacity' },
      { name: 'Nanodegree in Agentic AI', issuer: 'Udacity', issuedDate: '2026-01' },
    );
    assert(merged.name === 'Nanodegree in Agentic AI', `longer name wins, got ${merged.name}`);
    assert(merged.issuedDate === '2026-01', 'a date present in either survives');
  });

  test('a credential URL is never lost to a row that lacked one', () => {
    const merged = mergeCertifications(
      { name: 'CSS (Basic)', issuer: 'HackerRank', credentialUrl: 'https://hackerrank.example/abc' },
      { name: 'CSS (Basic)', issuer: 'HackerRank' },
    );
    assert(merged.credentialUrl === 'https://hackerrank.example/abc', 'kept');
  });

  test('the live list collapses by exactly one', () => {
    const observed = [
      { name: 'Nanodegree in Agentic AI', issuer: 'Udacity' },
      { name: 'Nanodegree, Agentic AI', issuer: 'Udacity' },
      { name: 'CSS (Basic)', issuer: 'HackerRank' },
      { name: 'Java (Basic)', issuer: 'HackerRank' },
      { name: 'Introduction to Data Science', issuer: 'Infosys Springboard' },
      { name: 'Introduction to Digital Marketing', issuer: 'Great Learning' },
    ];
    const deduped = dedupeCertifications(observed);
    assert(deduped.length === 5, `expected 5 from these 6, got ${deduped.length}`);
    assert(
      deduped.filter((c) => /nanodegree/i.test(c.name)).length === 1,
      'and it is the Udacity pair that merged',
    );
  });

  test('a nameless row is dropped rather than keyed on empty', () => {
    assert(dedupeCertifications([{ name: '   ', issuer: 'Somewhere' }]).length === 0, 'skipped');
  });
});

suite('hashing', () => {
  test('the hash is over the normalised identity, not the raw text', () => {
    const a = certificationHashParts({ name: 'Nanodegree in Agentic AI', issuer: 'Udacity' });
    const b = certificationHashParts({ name: 'Nanodegree, Agentic AI', issuer: 'Udacity' });
    assert(a.join('|') === b.join('|'), 'the two spellings hash alike, so the second insert collides');
  });

  test("the 'cert' prefix is preserved", () => {
    // Every stored certificate was written with this prefix, and a hand-typed one still
    // is. Changing it would make every existing row look like a new record.
    assert(certificationHashParts({ name: 'x', issuer: 'y' })[0] === 'cert', 'prefix kept');
  });
});
