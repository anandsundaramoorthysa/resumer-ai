/**
 * Layer 1 of the profile steward — lib/steward/tidy.ts. Every case is a defect found in the
 * owner's real profile (STEWARD.md §2.2), or a way a fix for one could damage a fact.
 */

import { tidyDate, tidyRecordData, tidyText } from '../lib/steward/tidy';
import { dedupeStackNames } from '../lib/skills/identity';
import { suite, test, assert } from './harness.mjs';

const NBH = String.fromCharCode(0x2011);
const NBSP = String.fromCharCode(0x00a0);
const ZWSP = String.fromCharCode(0x200b);

suite('tidy — typography, never facts', () => {
  test('look-alike hyphens, odd spaces and zero-width characters become plain', () => {
    assert.equal(
      tidyText(`Worked with open${NBH}source AI${NBSP}models${ZWSP}  in  Flask. `),
      'Worked with open-source AI models in Flask.',
    );
  });

  test('a description that only repeats the title is dropped', () => {
    const out = tidyRecordData('achievement', {
      title: 'First Prize in Debugging at SPARK 2K24 Symposium',
      description: 'First Prize in Debugging at SPARK 2K24 Symposium',
    });
    assert.deepEqual(out, { title: 'First Prize in Debugging at SPARK 2K24 Symposium' });
  });

  test('a description that says more is kept', () => {
    const out = tidyRecordData('award', { title: 'First Prize', description: 'First Prize among 40 teams' });
    assert.equal(out.description, 'First Prize among 40 teams');
  });

  test('a skill takes its canonical spelling', () => {
    assert.equal(tidyRecordData('skill', { name: 'time series', category: 'tool' }).name, 'Time Series');
    assert.equal(tidyRecordData('skill', { name: 'typescript', category: 'language' }).name, 'TypeScript');
  });

  test('a stack loses repeats, and package names keep their author spelling', () => {
    assert.deepEqual(
      dedupeStackNames(['React', 'React.js', 'markdown-it', 'html-to-docx', 'typescript']),
      ['React', 'markdown-it', 'html-to-docx', 'TypeScript'],
    );
  });

  test('single dates written in words become YYYY-MM; ranges are left alone', () => {
    assert.equal(tidyDate('Sep 2023'), '2023-09');
    assert.equal(tidyDate('September 2023'), '2023-09');
    assert.equal(tidyDate('09/2023'), '2023-09');
    assert.equal(tidyDate('Present'), 'present');
    assert.equal(tidyDate('Jun 2025 – Apr 2026'), 'Jun 2025 – Apr 2026');
    assert.equal(tidyDate('2015-01-01'), '2015-01-01');
  });

  test('empty list entries go; the input object is not modified', () => {
    const input = { name: 'X', stack: ['Python', ' ', ''] };
    const out = tidyRecordData('project', input);
    assert.deepEqual(out.stack, ['Python']);
    assert.deepEqual(input.stack, ['Python', ' ', '']);
  });
});
