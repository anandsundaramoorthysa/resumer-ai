/**
 * Skill normalisation — AUDIT #11.
 *
 * Two halves, and the second is the one that matters. Proving that "React", "React.js"
 * and "ReactJS" collapse is easy and would be satisfied by almost any implementation,
 * including several that are actively dangerous. So every merge case below is paired with
 * a separation case drawn from the list of pairs the module deliberately keeps apart:
 * Java/JavaScript, C/C++/C#, R/Ruby, Angular/AngularJS, Next.js/Nest.js. A normaliser
 * that merges those inflates nothing — it puts a language on the resume that the person
 * has never written, which is the failure the whole design exists to prevent (NFR-8).
 */

import { assert, suite, test } from './harness.mjs';
import {
  canonicalSkillName,
  dedupeBySkillIdentity,
  dedupeSkillNames,
  skillAliases,
  skillIdentity,
} from '@/lib/skills/identity';
import { scoreKeywordCoverage } from '@/lib/quality/keywords';
import { profileVocabulary, scoreSkillsCompleteness } from '@/lib/quality/skills';
import type { JobRequirement, ProfileRecord, ResumeDocument } from '@/lib/types';

const same = (a: string, b: string) =>
  assert.equal(skillIdentity(a), skillIdentity(b), `${a} and ${b} should be one skill`);

const apart = (a: string, b: string) =>
  assert.notEqual(
    skillIdentity(a),
    skillIdentity(b),
    `${a} and ${b} must never be merged`,
  );

suite('skill identity — spellings that are one skill', () => {
  test('React, React.js, ReactJS and react are one', () => {
    same('React', 'React.js');
    same('React', 'ReactJS');
    same('React', 'react');
    assert.equal(dedupeSkillNames(['React', 'React.js', 'ReactJS', 'react']).length, 1);
  });

  test('Node and Node.js are one, and print as Node.js', () => {
    same('Node', 'Node.js');
    same('Node', 'nodejs');
    assert.equal(canonicalSkillName('nodejs'), 'Node.js');
  });

  test('JS and JavaScript are one', () => {
    same('JS', 'JavaScript');
    assert.equal(canonicalSkillName('js'), 'JavaScript');
  });

  test('Go and Golang are one', () => {
    same('Go', 'Golang');
    assert.equal(canonicalSkillName('golang'), 'Go');
  });

  test('spacing, case and trailing punctuation never make a second skill', () => {
    same('postgres', 'PostgreSQL');
    same('Tailwind CSS', 'tailwindcss');
    same('Python.', 'python');
  });

  test('an unknown skill keeps the user own wording', () => {
    assert.equal(canonicalSkillName('Screaming Frog'), 'Screaming Frog');
    same('Screaming Frog', 'screaming  frog');
  });
});

suite('skill display — the case a Skills line prints in', () => {
  // The line that prompted this, from a real generated resume: skill records made from
  // job-posting keywords kept the posting's prose casing, next to properly cased ones.
  test('the reported Skills line prints in one consistent case', () => {
    const line = dedupeSkillNames([
      'regression', 'Python', 'SQL', 'statistics', 'segmentation', 'Data Science',
      'classification', 'clustering',
    ]);
    assert.deepEqual(line, [
      'Regression', 'Python', 'SQL', 'Statistics', 'Segmentation', 'Data Science',
      'Classification', 'Clustering',
    ]);
  });

  test('plain lowercase phrases are title-cased, small words after the first are not', () => {
    assert.equal(canonicalSkillName('exploratory data analysis'), 'Exploratory Data Analysis');
    assert.equal(canonicalSkillName('design of experiments'), 'Design of Experiments');
    assert.equal(canonicalSkillName('time-series analysis'), 'Time-Series Analysis');
    assert.equal(canonicalSkillName('of mice and men'), 'Of Mice and Men');
  });

  test('names lowercase by their owners convention stay lowercase', () => {
    for (const name of ['pandas', 'scikit-learn', 'seaborn', 'npm', 'pnpm', 'pytest']) {
      assert.equal(canonicalSkillName(name), name);
    }
    assert.equal(canonicalSkillName('sklearn'), 'scikit-learn');
    same('sklearn', 'scikit-learn');
  });

  test('brands with inner capitals and acronyms print their real spelling', () => {
    assert.equal(canonicalSkillName('jquery'), 'jQuery');
    assert.equal(canonicalSkillName('ios'), 'iOS');
    assert.equal(canonicalSkillName('macos'), 'macOS');
    assert.equal(canonicalSkillName('grpc'), 'gRPC');
    assert.equal(canonicalSkillName('numpy'), 'NumPy');
    assert.equal(canonicalSkillName('pytorch'), 'PyTorch');
    assert.equal(canonicalSkillName('github'), 'GitHub');
    assert.equal(canonicalSkillName('power bi'), 'Power BI');
    assert.equal(canonicalSkillName('nlp'), 'NLP');
    assert.equal(canonicalSkillName('a/b testing'), 'A/B Testing');
    assert.equal(canonicalSkillName('ci/cd'), 'CI/CD');
  });

  test('casing the user chose is never overridden', () => {
    assert.equal(canonicalSkillName('Data science'), 'Data science');
    assert.equal(canonicalSkillName('eBPF'), 'eBPF');
  });

  test('identifiers are spelled, not cased', () => {
    assert.equal(canonicalSkillName('vue3'), 'vue3');
    assert.equal(canonicalSkillName('d3.js'), 'd3.js');
  });

  test('casing changes the print, never the identity', () => {
    same('statistics', 'Statistics');
    apart('SQL', 'PostgreSQL');
  });
});

suite('skill identity — the pairs kept apart on purpose', () => {
  test('Java is not JavaScript, and JS is not Java', () => {
    apart('Java', 'JavaScript');
    apart('JS', 'Java');
  });

  test('C, C++ and C# are three languages', () => {
    apart('C', 'C++');
    apart('C', 'C#');
    apart('C++', 'C#');
    assert.equal(dedupeSkillNames(['C', 'C++', 'C#']).length, 3);
  });

  test('R is not Ruby and not Rust', () => {
    apart('R', 'Ruby');
    apart('R', 'Rust');
  });

  test('Angular and AngularJS are separate ecosystems', () => {
    apart('Angular', 'AngularJS');
  });

  test('Next.js is not Nest.js, and neither is the word "next"', () => {
    apart('Next.js', 'Nest.js');
    apart('Next.js', 'next');
  });

  test('React Native is not React, and PostgreSQL is not SQL', () => {
    apart('React', 'React Native');
    apart('SQL', 'PostgreSQL');
  });
});

suite('dedupe keeps the order retrieval chose', () => {
  test('the first spelling seen is the survivor position', () => {
    const out = dedupeSkillNames(['TypeScript', 'React.js', 'Go', 'ReactJS', 'Golang']);
    assert.deepEqual(out, ['TypeScript', 'React', 'Go']);
  });

  test('dedupeBySkillIdentity keeps the first record, not the last', () => {
    const records = [
      { id: 'a', name: 'React' },
      { id: 'b', name: 'ReactJS' },
      { id: 'c', name: 'Vue' },
    ];
    assert.deepEqual(
      dedupeBySkillIdentity(records, (r) => r.name).map((r) => r.id),
      ['a', 'c'],
    );
  });
});

suite('the scorers consume it', () => {
  const recordBase = {
    userId: 'u1',
    source: 'manual' as const,
    flaggedForRemoval: false,
    reviewState: 'approved' as const,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const records: ProfileRecord[] = [
    {
      ...recordBase, id: 's1', type: 'skill', name: 'Node', category: 'framework',
      tags: ['node'], contentHash: 'h1',
    },
    {
      ...recordBase, id: 's2', type: 'skill', name: 'Go', category: 'language',
      tags: ['go'], contentHash: 'h2',
    },
  ];

  const job: JobRequirement = {
    roleTitle: 'Backend Engineer',
    company: 'Acme',
    seniority: 'mid',
    category: 'full-stack',
    requiredSkills: ['Node.js'],
    preferredSkills: [],
    responsibilities: [],
    atsKeywords: ['Node.js', 'Golang'],
    tone: 'neutral',
    confidence: 0.9,
    flags: [],
  };

  const doc: ResumeDocument = {
    id: 'd1',
    userId: 'u1',
    contact: { fullName: 'Anand', email: 'anand@example.com' },
    sections: [
      { key: 'skills', heading: 'Skills', items: [{ text: 'Node, Go', sourceRecordId: null }] },
    ],
    jobRequirement: job,
    renderMode: 'ats-strict',
    recordHashSnapshot: [],
    createdAt: new Date('2024-06-01'),
  };

  test('the profile vocabulary answers for both spellings', () => {
    const vocab = profileVocabulary(records);
    assert.ok(vocab.has('node'));
    assert.ok(vocab.has('node.js'), 'the canonical spelling is claimable too');
  });

  test('a Skills line saying "Node" satisfies a posting asking for "Node.js"', () => {
    const r = scoreSkillsCompleteness(doc, records);
    assert.deepEqual(r.genuineGaps, [], 'these are not gaps — the profile holds both');
    assert.deepEqual(r.missingButHeld, []);
    assert.equal(r.score, 1);
  });

  test('the keyword gate stops missing "Golang" on a resume that says "Go"', () => {
    const r = scoreKeywordCoverage(doc);
    assert.deepEqual(r.missing, []);
    assert.equal(r.coveragePct, 1);
  });

  test('it still refuses a keyword the profile does not hold', () => {
    const r = scoreSkillsCompleteness(
      { ...doc, jobRequirement: { ...job, atsKeywords: ['Java'] } },
      records,
    );
    assert.deepEqual(r.genuineGaps, ['Java'], 'JavaScript-adjacent is not Java');
  });

  test('every alias of a keyword is a spelling of the same skill, never a neighbour', () => {
    assert.ok(skillAliases('Node.js').includes('node'));
    assert.ok(!skillAliases('Java').includes('javascript'));
    assert.ok(!skillAliases('C').includes('c++'));
  });
});
