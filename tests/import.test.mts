/**
 * Resume-importer tests — tasks 2.1/2.2/2.3, the deterministic half.
 *
 * The AI call is the only part of the importer that cannot be tested without a provider
 * key, so everything around it is: the chunking that keeps each call small enough to
 * finish inside one request, and the merge that turns per-chunk output into the exact
 * candidate list the confirm screen shows. Nothing is written to a profile without
 * passing through `buildPreview` first, which makes it the last checkable point before
 * the user's decision.
 */

import { assert, report, suite, test } from './harness.mjs';
import { MAX_CHUNK_CHARS, chunkResumeText, formatFromFile } from '@/lib/import/text';
import { buildPreview } from '@/lib/import/parse';
import type { ExtractedProfile } from '@/lib/sync/parse';

/* ---------------------------------------------------------- file typing ---- */

suite('upload typing (task 2.1)', () => {
  test('accepts PDF and DOCX by extension', () => {
    assert.equal(formatFromFile('Anand_Resume.pdf', ''), 'pdf');
    assert.equal(formatFromFile('Anand_Resume.DOCX', ''), 'docx');
  });

  test('accepts them by MIME type when the name has no extension', () => {
    assert.equal(formatFromFile('upload', 'application/pdf'), 'pdf');
    assert.equal(
      formatFromFile(
        'upload',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      'docx',
    );
  });

  test('rejects everything else, including the formats that look close', () => {
    for (const [name, type] of [
      ['resume.doc', 'application/msword'],
      ['resume.txt', 'text/plain'],
      ['resume.pages', ''],
      ['resume.png', 'image/png'],
    ] as const) {
      assert.equal(formatFromFile(name, type), null, `${name} should be rejected`);
    }
  });
});

/* -------------------------------------------------------------- chunking ---- */

suite('chunking (task 2.2)', () => {
  const section = (heading: string, lines: number) =>
    `${heading}\n${Array.from({ length: lines }, (_, i) => `${heading} line ${i} with enough words in it to take up some space`).join('\n')}`;

  test('a short resume stays in one chunk — no reason to split it', () => {
    const chunks = chunkResumeText('Anand Sundaramoorthy\n\nSkills\nReact, PostgreSQL');
    assert.equal(chunks.length, 1);
  });

  test('every chunk stays inside the measured fast band', () => {
    const text = [
      section('EXPERIENCE', 12),
      section('PROJECTS', 12),
      section('EDUCATION', 6),
    ].join('\n\n');

    const chunks = chunkResumeText(text);
    assert.ok(chunks.length > 1, 'a long resume must be split');
    for (const chunk of chunks) {
      assert.ok(
        chunk.length <= MAX_CHUNK_CHARS,
        `a ${chunk.length}-char chunk exceeds the ${MAX_CHUNK_CHARS} budget`,
      );
    }
  });

  test('no content is dropped in the split', () => {
    const text = [section('EXPERIENCE', 20), section('SKILLS', 8)].join('\n\n');
    const rejoined = chunkResumeText(text).join('\n').replace(/\s+/g, ' ');
    for (const line of text.split('\n').filter(Boolean)) {
      assert.ok(rejoined.includes(line.trim()), `lost: ${line.slice(0, 40)}`);
    }
  });

  test('an unbroken wall of text is still split rather than sent whole', () => {
    const wall = 'word '.repeat(2_000).trim();
    const chunks = chunkResumeText(wall);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= MAX_CHUNK_CHARS);
  });

  test('a single line longer than the budget is cut rather than skipped', () => {
    const chunks = chunkResumeText('x'.repeat(MAX_CHUNK_CHARS * 3));
    assert.equal(chunks.length, 3);
    assert.equal(chunks.join('').length, MAX_CHUNK_CHARS * 3);
  });

  test('empty input produces no work', () => {
    assert.deepEqual(chunkResumeText('   \n\n  '), []);
  });
});

/* --------------------------------------------------------------- preview ---- */

function partial(over: Partial<ExtractedProfile>): ExtractedProfile {
  return {
    contact: undefined,
    skills: [],
    projects: [],
    experience: [],
    education: [],
    certifications: [],
    achievements: [],
    ...over,
  };
}

suite('review candidates (task 2.3)', () => {
  const partials = [
    partial({
      contact: { fullName: 'Anand Sundaramoorthy', email: 'anand@example.com' },
      skills: [
        { name: 'React', category: 'framework' },
        { name: 'PostgreSQL', category: 'tool' },
      ],
    }),
    partial({
      // Deliberately repeats React: two chunks of one resume routinely name the same
      // skill, and the review list must not offer it twice.
      skills: [{ name: 'React', category: 'framework' }],
      experience: [
        {
          company: 'Acme',
          title: 'Senior Engineer',
          startDate: '2022-01',
          endDate: 'present',
          bullets: [
            { text: 'Rebuilt the checkout flow.', action: 'Rebuilt the checkout flow' },
            { text: 'Cut p95 latency 40%.', action: 'Cut p95 latency', outcome: '40%' },
          ],
        },
      ],
    }),
    partial({
      projects: [
        {
          name: 'Ledger',
          description: 'Billing reconciliation tool',
          stack: ['TypeScript'],
          links: [],
          impactMetrics: [],
        },
      ],
      education: [{ institution: 'Anna University', credential: 'B.E.' }],
      certifications: [{ name: 'AWS SAA', issuer: 'Amazon' }],
      achievements: [{ title: 'Speaker, JSConf', description: 'Talk on ATS parsing' }],
    }),
  ];

  const preview = buildPreview(partials);

  test('merges chunks without offering the same fact twice', () => {
    const skills = preview.records.filter((r) => r.type === 'skill');
    assert.equal(skills.length, 2);
    assert.deepEqual(skills.map((s) => s.label).sort(), ['PostgreSQL', 'React']);
  });

  test('bullets are grouped under the role they came from', () => {
    assert.equal(preview.roles.length, 1);
    assert.equal(preview.roles[0].title, 'Senior Engineer');
    assert.equal(preview.roles[0].company, 'Acme');
    assert.equal(preview.roles[0].bullets.length, 2);
  });

  test('every candidate is marked as an AI import, never as manual or synced', () => {
    const all = [
      ...preview.records,
      ...preview.roles.flatMap((r) => r.bullets),
    ];
    assert.ok(all.length > 0);
    for (const c of all) {
      assert.equal(
        (c.record as { source?: string }).source,
        'ai-import',
        `${c.label} claimed the wrong provenance`,
      );
    }
  });

  test('every candidate carries a content hash and a stable key', () => {
    const keys = new Set<string>();
    for (const c of [...preview.records, ...preview.roles.flatMap((r) => r.bullets)]) {
      assert.ok(c.record.contentHash, `${c.label} has no content hash`);
      assert.ok(!keys.has(c.key), `duplicate key ${c.key}`);
      keys.add(c.key);
    }
  });

  test('the same input produces the same keys, so a re-run is idempotent', () => {
    const again = buildPreview(partials);
    assert.deepEqual(
      again.records.map((r) => r.key).sort(),
      preview.records.map((r) => r.key).sort(),
    );
  });

  test('contact details are surfaced for confirmation, not applied silently', () => {
    assert.equal(preview.contact?.fullName, 'Anand Sundaramoorthy');
    assert.equal(preview.contact?.email, 'anand@example.com');
  });

  test('every extracted category reaches the review list', () => {
    const types = new Set(preview.records.map((r) => r.type));
    for (const expected of ['skill', 'project', 'education', 'certification', 'achievement']) {
      assert.ok(types.has(expected), `${expected} never made it to review`);
    }
    assert.equal(preview.totalCount, preview.records.length + 2);
  });

  test('an extraction that found nothing produces an empty list, not a guess', () => {
    const empty = buildPreview([partial({})]);
    assert.equal(empty.totalCount, 0);
    assert.deepEqual(empty.records, []);
    assert.deepEqual(empty.roles, []);
  });
});

report('import');
