/**
 * Resume line shaping — lib/generate/resume-lines.ts and the two-page rule in
 * lib/quality/length.ts.
 */

import { suite, test, assert } from './harness.mjs';
import {
  educationLine,
  educationYears,
  formatSkillRow,
  groupSkills,
  parseSkillRow,
  topByRelevance,
} from '../lib/generate/resume-lines';
import { lengthVerdict } from '../lib/quality/length';
import type { JobRequirement, ProfileRecord, ResumeDocument } from '../lib/types';

const job: JobRequirement = {
  roleTitle: 'Data Analyst Intern',
  seniority: 'intern',
  category: 'data',
  requiredSkills: ['SQL'],
  preferredSkills: [],
  responsibilities: [],
  atsKeywords: ['SQL', 'Python', 'Machine Learning'],
  tone: 'corporate',
  confidence: 1,
  flags: [],
};

suite('skill rows', () => {
  // The owner's own layout, from their screenshot.
  const rows = groupSkills([
    'Python', 'JavaScript', 'TypeScript', 'Data Structures and Algorithms', 'MongoDB',
    'MySQL', 'Firebase', 'Upstash Vector DB', 'Next.js', 'Node.js', 'Retrieval-Augmented Generation (RAG)',
    'OpenAI API', 'XGBoost', 'Pandas', 'Git', 'Docker', 'Streamlit',
    'Search Engine Optimization (SEO)', 'Google Analytics', 'Communication', 'Technical Writing',
  ]);
  const row = (label: string) => rows.find((r) => r.label === label)?.names ?? [];

  test('languages, databases and web land in their rows', () => {
    assert.deepEqual(row('Programming Languages'), ['Python', 'JavaScript', 'TypeScript']);
    assert.deepEqual(row('Databases'), ['MongoDB', 'MySQL', 'Firebase', 'Upstash Vector DB']);
    assert.deepEqual(row('Web'), ['Next.js', 'Node.js']);
  });

  test('an AI API is AI, not Web — "OpenAI API" contains "api"', () => {
    assert.ok(row('AI and ML').includes('OpenAI API'));
    assert.ok(!row('Web').includes('OpenAI API'));
  });

  test('SEO, tools and soft skills', () => {
    assert.deepEqual(row('Marketing and SEO'), ['Search Engine Optimization (SEO)', 'Google Analytics']);
    assert.deepEqual(row('Software and Tools'), ['Git', 'Docker', 'Streamlit']);
    assert.deepEqual(row('Soft Skills'), ['Communication', 'Technical Writing']);
  });

  test('rows print in the owner\'s order', () => {
    const labels = rows.map((r) => r.label);
    assert.ok(labels.indexOf('Web') < labels.indexOf('AI and ML'));
    assert.ok(labels.indexOf('AI and ML') < labels.indexOf('Soft Skills'));
  });

  test('data-science methods are AI and ML, not Other', () => {
    // They fell into "Other" on the owner's real profile.
    const labels = groupSkills(['statistics', 'clustering', 'time series', 'segmentation']).map((r) => r.label);
    assert.deepEqual(labels, ['AI and ML']);
  });

  test('an unknown skill falls back to its category, then to Other', () => {
    assert.equal(groupSkills(['Zig'], () => 'language')[0].label, 'Programming Languages');
    assert.equal(groupSkills(['Blockchain'])[0].label, 'Other');
  });

  test('a row survives formatting and parsing unchanged', () => {
    const r = { label: 'Databases', names: ['MongoDB', 'MySQL'] };
    assert.equal(formatSkillRow(r), 'Databases: MongoDB, MySQL');
    assert.deepEqual(parseSkillRow(formatSkillRow(r)), r);
  });
});

suite('education', () => {
  test('the degree is spelled out and the field is not printed twice', () => {
    assert.equal(educationLine('M.Sc. Data Science', 'Data Science'), 'Master of Science, Data Science');
  });

  test('a grade follows the degree', () => {
    assert.equal(
      educationLine('B.Sc. Computer Science', 'Computer Science', '7.5 / 10'),
      'Bachelor of Science, Computer Science · 7.5 / 10',
    );
  });

  test('an unrecognised credential is left as written, field added only if missing', () => {
    assert.equal(educationLine('Diploma in Design', 'Design'), 'Diploma in Design');
    assert.equal(educationLine('Diploma', 'Design'), 'Diploma, Design');
  });

  test('years only', () => {
    assert.equal(educationYears('2022-08', '2025-04'), '2022 – 2025');
    assert.equal(educationYears('2024-06', 'present'), '2024 – Present');
  });
});

suite('picking the top three', () => {
  const cert = (id: string, name: string, issuedDate = ''): ProfileRecord =>
    ({
      id, type: 'certification', name, issuer: 'X', issuedDate, tags: [], userId: 'u',
      source: 'manual', contentHash: id, flaggedForRemoval: false, reviewState: 'approved',
      createdAt: new Date(), updatedAt: new Date(),
    }) as ProfileRecord;

  test('the ones matching the posting come first, capped at three', () => {
    const picked = topByRelevance(
      [cert('a', 'Hindi Proficiency'), cert('b', 'SQL for Data Science'), cert('c', 'Python Basics'),
       cert('d', 'Machine Learning with Python'), cert('e', 'Public Speaking')],
      job,
      3,
    );
    assert.deepEqual(picked.map((c) => c.id), ['d', 'b', 'c']);
  });
});

suite('two pages when the required sections need them', () => {
  const lines = (n: number, key: ResumeDocument['sections'][number]['key']) => ({
    key,
    heading: key,
    items: Array.from({ length: n }, (_, i) => ({ text: `line ${i} with a handful of plain words`, sourceRecordId: null })),
  });
  const doc = (sections: ResumeDocument['sections']): ResumeDocument =>
    ({ id: 'd', userId: 'u', contact: { fullName: 'A', email: 'a@x.dev' }, sections,
       jobRequirement: job, renderMode: 'ats-strict', recordHashSnapshot: [], createdAt: new Date() }) as ResumeDocument;

  test('40 required lines are allowed — they cannot be trimmed', () => {
    assert.equal(lengthVerdict(doc([lines(20, 'experience'), lines(20, 'achievements')])), 'ok');
  });

  test('but optional projects cannot buy the second page', () => {
    assert.equal(lengthVerdict(doc([lines(20, 'experience'), lines(20, 'projects')])), 'long');
  });
});
