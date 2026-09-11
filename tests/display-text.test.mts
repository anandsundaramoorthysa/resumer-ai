/**
 * Display tidying — lib/generate/display-text.ts.
 *
 * Every "fixes it" case is paired with a "leaves it alone" case, for the same reason the
 * skill-identity suite pairs merges with separations: capitalising "iOS" or "pandas" is
 * not a smaller version of the lowercase-bullet bug, it is a new one.
 */

import { assert, suite, test } from './harness.mjs';
import {
  capitaliseFirst,
  printable,
  tidyResumeText,
  withoutRepeatedParts,
} from '@/lib/generate/display-text';
import type { ResumeDocument } from '@/lib/types';

suite('capitaliseFirst — a sentence starts on a capital', () => {
  test('a lowercase bullet or description is capitalised', () => {
    assert.equal(capitaliseFirst('built a churn model in Python.'), 'Built a churn model in Python.');
    assert.equal(capitaliseFirst('e-commerce dashboard for sales'), 'E-commerce dashboard for sales');
  });

  test('only the first letter changes', () => {
    assert.equal(capitaliseFirst('reduced latency using gRPC'), 'Reduced latency using gRPC');
  });

  test('a first word cased on purpose is left alone', () => {
    assert.equal(capitaliseFirst('iOS app for tracking stock prices'), 'iOS app for tracking stock prices');
    assert.equal(capitaliseFirst('jQuery plugin with 2k installs'), 'jQuery plugin with 2k installs');
    assert.equal(capitaliseFirst('eBay listing scraper'), 'eBay listing scraper');
  });

  test('a first word lowercase by convention is left alone', () => {
    assert.equal(capitaliseFirst('pandas pipeline that cleans survey data'), 'pandas pipeline that cleans survey data');
    assert.equal(capitaliseFirst('npm package for date parsing'), 'npm package for date parsing');
    assert.equal(capitaliseFirst('scikit-learn models for churn'), 'scikit-learn models for churn');
  });

  test('text that already starts on a capital, a digit or a symbol is untouched', () => {
    assert.equal(capitaliseFirst('A Telegram bot.'), 'A Telegram bot.');
    assert.equal(capitaliseFirst('5-stage pipeline'), '5-stage pipeline');
    assert.equal(capitaliseFirst(''), '');
  });
});

suite('withoutRepeatedParts — one fact once per line', () => {
  test('the reported education line loses its repeated field', () => {
    assert.deepEqual(
      withoutRepeatedParts(['M.Sc. Data Science', 'Data Science', 'Loyola College (Autonomous), Chennai', 'Jun 2024 – 2027']),
      ['M.Sc. Data Science', 'Loyola College (Autonomous), Chennai', 'Jun 2024 – 2027'],
    );
    assert.deepEqual(
      withoutRepeatedParts(['B.Sc. Computer Science', 'computer science']),
      ['B.Sc. Computer Science'],
    );
  });

  test('a field the credential does not name is kept', () => {
    assert.deepEqual(withoutRepeatedParts(['B.Tech.', 'Computer Science', 'IIT Madras']), [
      'B.Tech.',
      'Computer Science',
      'IIT Madras',
    ]);
  });

  test('only whole phrases count, and a later, longer part is never dropped', () => {
    assert.deepEqual(withoutRepeatedParts(['B.Sc. Statistics', 'Stat']), ['B.Sc. Statistics', 'Stat']);
    assert.deepEqual(
      withoutRepeatedParts(['B.Sc.', 'Computer Science', 'Institute of Computer Science']),
      ['B.Sc.', 'Computer Science', 'Institute of Computer Science'],
    );
  });

  test('blanks and undefined are skipped, as filter(Boolean) did', () => {
    assert.deepEqual(withoutRepeatedParts(['B.Sc.', undefined, '  ', 'Loyola']), ['B.Sc.', 'Loyola']);
  });
});

suite('tidyResumeText — sentences, not lists of names', () => {
  const doc: ResumeDocument = {
    id: 'd1',
    userId: 'u1',
    contact: { fullName: 'Anand', email: 'anand@example.com' },
    sections: [
      { key: 'summary', heading: 'Summary', items: [{ text: 'data scientist who ships.', sourceRecordId: null }] },
      { key: 'skills', heading: 'Skills', items: [{ text: 'pandas, NumPy, SQL', sourceRecordId: null }] },
      {
        key: 'projects',
        heading: 'Projects',
        items: [],
        groups: [
          {
            title: 'tamilkavi',
            subtitle: 'Python',
            items: [{ text: 'a Python package for Tamil poetry.', sourceRecordId: 'p1' }],
          },
        ],
      },
      { key: 'certifications', heading: 'Certifications', items: [{ text: 'iOS Basics · Udemy', sourceRecordId: 'c1' }] },
    ],
    jobRequirement: null,
    renderMode: 'ats-strict',
    recordHashSnapshot: [],
    createdAt: new Date('2026-09-11'),
  };

  const out = tidyResumeText(doc);
  const text = (key: string) => out.sections.find((s) => s.key === key)!;

  test('summary and group bullets are capitalised', () => {
    assert.equal(text('summary').items[0].text, 'Data scientist who ships.');
    assert.equal(text('projects').groups![0].items[0].text, 'A Python package for Tamil poetry.');
  });

  test('the Skills line and group titles are names, and are not touched', () => {
    assert.equal(text('skills').items[0].text, 'pandas, NumPy, SQL');
    assert.equal(text('projects').groups![0].title, 'tamilkavi');
    assert.equal(text('certifications').items[0].text, 'iOS Basics · Udemy');
  });

  test('the input document is not mutated', () => {
    assert.equal(doc.sections[0].items[0].text, 'data scientist who ships.');
  });
});

suite('printable — hyphens the PDF font can draw', () => {
  test('a model\'s non-breaking hyphen prints as a plain one', () => {
    // Printed as "product focused", read by an ATS as "productfocused".
    assert.equal(printable('product‑focused, real‐world, end‑to‑end'), 'product-focused, real-world, end-to-end');
    assert.equal(printable('data­visualization'), 'datavisualization');
  });
});
