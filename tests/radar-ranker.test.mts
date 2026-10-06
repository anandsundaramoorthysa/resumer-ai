import { readFileSync } from 'node:fs';
import { suite, test, assert } from './harness.mjs';
import { rankPostings, mentionedSkills, matchesSkill, canonicalSkills, normalizeCity, NO_MATCH_REASON } from '../lib/radar/ranker';
import type { Posting } from '../lib/serp/types';
import type { ProfileRecord, RoleRecord } from '../lib/types';

const base = { userId: 'u', source: 'manual' as const, flaggedForRemoval: false, reviewState: 'approved' as const, createdAt: new Date(), updatedAt: new Date() };
const skill = (id: string, name: string): ProfileRecord =>
  ({ ...base, id, type: 'skill', name, category: 'language', tags: [], contentHash: id }) as ProfileRecord;
const records = [skill('1', 'Python'), skill('2', 'SQL'), skill('3', 'React')];
const role = (title: string, startDate = '2022-01', endDate = 'present'): RoleRecord =>
  ({ id: title, userId: 'u', title, company: 'Acme', startDate, endDate, source: 'manual', contentHash: title, reviewState: 'approved' });
const roles: RoleRecord[] = [role('Data Analyst')];
const contact = { fullName: 'A', email: 'a@x.com', location: 'Chennai, India' };

const posting = (key: string, title: string, description: string, location = 'Chennai'): Posting => ({
  key, title, company: key, location, via: '', description, applyLinks: [], postedAt: '',
  scheduleType: '', salaryLpa: { min: 0, max: 0, source: 'none' }, highlights: [], serpJobId: '', fromQuery: 0,
});
const LONG = ' We are hiring and you will work with a great team on many interesting problems every day. '.repeat(3);

suite('rankPostings', () => {
  const good = posting('b-good', 'Data Analyst', `Python and SQL required, React nice.${LONG}`);
  const bad = posting('a-bad', 'Data Analyst', `Kubernetes, Terraform, Java and Kafka.${LONG}`);
  const ranked = rankPostings([bad, good], { records, roles, contact });

  test('matching posting outranks non-matching', () => {
    assert.equal(ranked[0].key, 'b-good');
    assert.ok(ranked[0].score > ranked[1].score);
  });
  test('matched and missing are correct', () => {
    assert.deepEqual([...ranked[0].matched].sort(), ['python', 'react', 'sql']);
    assert.deepEqual(ranked[0].missing, []);
    assert.ok(ranked[1].missing.includes('kubernetes'));
    assert.deepEqual(ranked[1].matched, []);
  });
  test('zero overlap: score 0, fixed reason, no seniority/location bonus, sorts last', () => {
    assert.equal(ranked[1].score, 0);
    assert.equal(ranked[1].reason, NO_MATCH_REASON);
    assert.equal(ranked[1].coveragePct, 0);
  });
  test('smoothed coverage: 3 of 3 asked scores below a naive 80 base, 1 of 1 below 3 of 3', () => {
    const one = rankPostings([posting('one', 'Role', `Python.${LONG}`)], { records, roles, contact })[0];
    assert.ok(one.score < ranked[0].score);
    assert.equal(one.coveragePct, 100);
  });
  test('reason counts agree with matched/asked', () => {
    const r = ranked[0];
    assert.ok(r.reason.startsWith(`You hold ${r.matched.length} of ${r.matched.length + r.missing.length} skills`));
    const mixed = rankPostings([posting('m', 'Role', `Python, Java, Kafka, Docker.${LONG}`)], { records, roles, contact })[0];
    assert.ok(mixed.reason.startsWith('You hold 1 of 4 skills it names; missing java, kafka, docker'));
  });
  test('empty description: no skills -> score 0 and says so', () => {
    const r = rankPostings([posting('e', 'Data Analyst', '')], { records, roles, contact })[0];
    assert.equal(r.score, 0);
    assert.ok(/short description/i.test(r.reason));
  });
  test('short penalty is 0.8, only under 120 chars and without highlights', () => {
    const long = rankPostings([posting('l', 'Data Analyst', `Python.${LONG}`)], { records, roles, contact })[0];
    const shortP = rankPostings([posting('s', 'Data Analyst', 'Python.')], { records, roles, contact })[0];
    assert.ok(shortP.score < long.score);
    assert.ok(Math.abs(shortP.score - Math.round(long.score * 0.8)) <= 1);
    assert.ok(/short description/.test(shortP.reason));
    const mid = rankPostings([posting('m', 'Data Analyst', `Python. ${'x'.repeat(130)}`)], { records, roles, contact })[0];
    assert.ok(!/short description/.test(mid.reason)); // 120..200 chars is no longer "short"
    const hl = { ...posting('h', 'Data Analyst', 'Python.'), highlights: ['Python daily'] };
    assert.ok(!/short description/.test(rankPostings([hl], { records, roles, contact })[0].reason));
  });
  test('topK and stable tie-break by key', () => {
    const ps = ['z', 'm', 'a'].map((k) => posting(k, 'Role', ''));
    const r = rankPostings(ps, { records, roles, contact }, 2);
    assert.deepEqual(r.map((x) => x.key), ['a', 'm']);
  });
  test('empty input', () => {
    assert.deepEqual(rankPostings([], { records: [], roles: [], contact }), []);
  });
  test('deterministic under shuffled input', () => {
    const ps = [bad, good, posting('c', 'Analyst', `SQL.${LONG}`), posting('d', 'Dev', `Python SQL Docker.${LONG}`)];
    const a = rankPostings(ps, { records, roles, contact }, 10);
    const b = rankPostings([...ps].reverse(), { records, roles, contact }, 10);
    assert.deepEqual(a, b);
  });
  test('ranker module does not import the model layer', () => {
    const src = readFileSync(new URL('../lib/radar/ranker.ts', import.meta.url), 'utf8');
    assert.ok(!/from '[^']*\/ai\//.test(src));
  });
});

suite('ML profile: role-title terms still count', () => {
  const ml = [skill('1', 'Python'), skill('2', 'Machine Learning'), skill('3', 'Pandas')];
  const mlRoles = [role('ML Intern', '2026-01', '2026-06')];
  const relevant = posting('ml', 'Machine Learning Engineer', `Python, machine learning and pandas.${LONG}`, 'Hyderabad');
  const irrelevant = posting('fe', 'Frontend Engineer', `React, TypeScript, CSS.${LONG}`, 'Hyderabad');
  test('relevant outranks irrelevant; machine learning is matched', () => {
    const r = rankPostings([irrelevant, relevant], { records: ml, roles: mlRoles, contact: { fullName: 'A', email: 'a@b.c', location: 'Hyderabad' } });
    assert.equal(r[0].key, 'ml');
    assert.ok(r[0].matched.includes('machine learning'));
    assert.equal(r[1].score, 0);
  });
  test('title family bonus: same coverage, matching family scores higher', () => {
    const a = posting('a', 'Data Scientist', `Python.${LONG}`);
    const b = posting('b', 'Sales Manager', `Python.${LONG}`);
    const r = rankPostings([b, a], { records: ml, roles: mlRoles, contact });
    assert.equal(r[0].key, 'a');
  });
});

suite('lexicon matching', () => {
  const has = (text: string, term: string) => assert.ok(mentionedSkills(text).includes(term), `${term} in "${text}"`);
  const lacks = (text: string, term: string) => assert.ok(!mentionedSkills(text).includes(term), `no ${term} in "${text}"`);

  test('whole word: reacts is not react; React is', () => {
    lacks('the service reacts to webhook events', 'react');
    lacks('you will react to incidents', 'react');
    has('We use React and Redux', 'react');
    has('ReactJS, React.js, react js', 'react');
    assert.ok(matchesSkill('React', 'react') && !matchesSkill('Reacts', 'react'));
  });
  test('names never pluralise; llm does', () => {
    lacks('sparks of rusts flasks', 'spark');
    lacks('Rusts', 'rust');
    has('LLMs and an LLM', 'llm');
  });
  test('ambiguous words are not skills on their own', () => {
    lacks('Express delivery logistics, express interest', 'express');
    lacks('swift response, a swift team', 'swift');
    lacks('Unit testing and QA testing', 'manual testing');
    lacks('the git of it', 'git');
    has('Node.js and Express.js APIs', 'express');
    has('expressjs, express js', 'express');
    has('iOS developer: Swift and SwiftUI', 'swift');
    has('Swift for the Xcode toolchain', 'swift');
    has('Git and GitHub workflows', 'git');
    has('version control', 'git');
  });
  test('js alias: framework .js does not imply javascript', () => {
    for (const t of ['Vue.js', 'next js', 'react.js', 'Node.js', 'Express js']) lacks(t, 'javascript');
    has('JavaScript', 'javascript');
    has('Vue.js and JS', 'javascript');
    has('plain js skills', 'javascript');
    has('Vue.js', 'vue');
    has('next js', 'next.js');
    has('nodejs', 'node.js');
  });
  test('go only as the language', () => {
    has('Golang services', 'go');
    has('Backend developer in Go', 'go');
    has('Go microservices at scale', 'go');
    has('Python, Go and Rust', 'go');
    lacks('Go to market strategy', 'go');
    lacks('go getter attitude, ready to go', 'go');
    lacks('We love to go the extra mile', 'go');
  });
  test('React Native is its own term', () => {
    has('React Native apps', 'react native');
    lacks('React Native apps', 'react');
    has('React Native and React', 'react');
  });
  test('aliases', () => {
    has('restful APIs', 'rest api');
    has('Gen AI', 'generative ai');
    has('MS Excel', 'excel');
    lacks('to excel in a team', 'excel');
    has('Machine-learning, ci-cd, k8s, Postgres, Power-BI', 'machine learning');
    has('ci-cd, k8s, Postgres, Power-BI', 'kubernetes');
    has('Postgres', 'postgresql');
    assert.deepEqual(canonicalSkills('Golang'), ['go']);
    assert.deepEqual(canonicalSkills('Go'), ['go']);
    assert.deepEqual(canonicalSkills('Next JS'), ['next.js']);
  });
  test('lexicon gaps are covered', () => {
    const t =
      'DevOps SAP Tally GST Looker Hibernate PySpark Spring Boot GitHub Actions RabbitMQ MLOps OpenCV LangChain RAG ' +
      'prompt engineering Playwright Cypress Postman manual testing Salesforce accounting Google Analytics content marketing ' +
      'social media copywriting email marketing SEM digital marketing recruitment payroll Photoshop Canva Figma AWS Docker ' +
      'Kubernetes Selenium SEO Power BI Excel LLM';
    for (const s of ['devops', 'sap', 'tally', 'gst', 'looker', 'hibernate', 'pyspark', 'spring', 'github actions', 'rabbitmq', 'mlops', 'opencv', 'langchain', 'rag', 'prompt engineering', 'playwright', 'cypress', 'postman', 'manual testing', 'salesforce', 'accounting', 'google analytics', 'content marketing', 'social media', 'copywriting', 'email marketing', 'sem', 'digital marketing', 'recruitment', 'payroll', 'photoshop', 'canva', 'figma', 'aws', 'docker', 'kubernetes', 'selenium', 'seo', 'power bi', 'excel', 'llm']) has(t, s);
  });
  test('substrings do not match (java vs javascript, sql vs nosql)', () => {
    lacks('JavaScript only', 'java');
    lacks('NoSQL and MySQL', 'sql');
    lacks('Sapphire cards, semester', 'sap');
  });
});

suite('profile holds', () => {
  test('a bare Go / Swift skill record counts', () => {
    const r = rankPostings(
      [posting('g', 'Backend Dev', `Golang and Swift.${LONG}`)],
      { records: [skill('1', 'Go')], roles: [], contact },
    )[0];
    assert.deepEqual(r.matched, ['go']);
  });
  test('react native on the profile does not make a React match', () => {
    const r = rankPostings(
      [posting('r', 'Dev', `React.${LONG}`)],
      { records: [skill('1', 'React Native')], roles: [], contact },
    )[0];
    assert.equal(r.score, 0);
  });
  test('empty profile scores 0', () => {
    const r = rankPostings([posting('x', 'Dev', `Python SQL.${LONG}`)], { records: [], roles: [], contact: { fullName: '', email: '' } });
    assert.equal(r[0].score, 0);
  });
});

suite('location', () => {
  test('city aliases normalise', () => {
    assert.equal(normalizeCity('Bangalore'), 'bengaluru');
    assert.equal(normalizeCity('Gurgaon, Haryana'), 'gurugram, haryana');
    assert.equal(normalizeCity('Bombay'), 'mumbai');
  });
  test('Bangalore profile gets the location bonus for a Bengaluru posting', () => {
    const p = (loc: string) => posting('k', 'Dev', `Python.${LONG}`, loc);
    const c = { fullName: '', email: '', location: 'Bangalore, India' };
    const here = rankPostings([p('Bengaluru, Karnataka')], { records, roles: [], contact: c })[0].score;
    const there = rankPostings([p('Pune')], { records, roles: [], contact: c })[0].score;
    assert.equal(here - there, 5);
  });
  test('bonuses never lift a zero-overlap posting', () => {
    const r = rankPostings([posting('z', 'Junior Data Analyst', `Java.${LONG}`, 'Remote')], { records, roles, contact })[0];
    assert.equal(r.score, 0);
  });
});
