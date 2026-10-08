/**
 * Product fixes from end-to-end testing: spoken languages vs programming languages, contact
 * URL validation, bullet-less jobs, interview evidence, the trailing period.
 */
delete process.env.DATABASE_URL;

import { suite, suiteAsync, test, testAsync, assert } from './harness.mjs';
import { spokenLanguage, isSpokenLanguage } from '../lib/skills/spoken';
import { groupSkills, mergeLanguageRow, formatSkillRow } from '../lib/generate/resume-lines';
import { toRecords } from '../lib/sync/parse';
import { cleanContactUrl, fillContactGaps } from '../lib/import/contact-links';
import { assembleResume } from '../lib/generate/assemble';
import { composeBulletText } from '../lib/profile/bullet';
import { verifiedEvidence, generateInterviewPrep } from '../lib/generate/interview';
import { setChainDeps, setTelemetrySink, setCooldownBackend, resetCooldownCache, resetBreakers } from '../lib/ai/chain';
import type { ExtractedProfile } from '../lib/sync/parse';
import type { ProfileRecord, ResumeDocument, RoleRecord, JobRequirement } from '../lib/types';

suite('spoken languages are not programming languages', () => {
  test('lexicon: English names, native scripts, annotations', () => {
    assert.equal(spokenLanguage('English'), 'English');
    assert.equal(spokenLanguage('हिन्दी'), 'Hindi');
    assert.equal(spokenLanguage('தமிழ்'), 'Tamil');
    assert.equal(spokenLanguage('Tamil (Native)'), 'Tamil');
    for (const n of ['Telugu', 'Kannada', 'Malayalam', 'Marathi', 'Bengali', 'Gujarati', 'Punjabi', 'Urdu', 'Odia']) assert(isSpokenLanguage(n), n);
    assert(!isSpokenLanguage('Python') && !isSpokenLanguage('Go') && !isSpokenLanguage(''));
  });

  test('the renderer groups stored rows under Languages, not Programming Languages', () => {
    const cat = (n: string) => (['Python', 'English', 'हिन्दी', 'தமிழ்'].includes(n) ? 'language' : undefined);
    const rows = groupSkills(['Python', 'English', 'हिन्दी', 'தமிழ்'], cat);
    assert.equal(formatSkillRow(rows.find((r) => r.label === 'Programming Languages')!), 'Programming Languages: Python');
    assert.deepEqual(rows.find((r) => r.label === 'Languages')!.names, ['English', 'हिन्दी', 'தமிழ்']);
  });

  test('language records merge into that row without duplicating', () => {
    const rows = mergeLanguageRow(groupSkills(['Python', 'English'], () => 'language'), ['English (Fluent)', 'Tamil (Native)']);
    assert.deepEqual(rows.find((r) => r.label === 'Languages')!.names, ['English (Fluent)', 'Tamil (Native)']);
  });

  test('the importer files them as language records, not skills', () => {
    const data = {
      skills: [{ name: 'Python', category: 'language' }, { name: 'English', category: 'language' }, { name: 'हिन्दी', category: 'language' }],
      projects: [], experience: [], education: [], certifications: [], achievements: [],
      languages: [{ name: 'Hindi', proficiency: 'native' }],
    } as unknown as ExtractedProfile;
    const { records } = toRecords(data);
    const names = (type: string) => records.filter((r) => r.type === type).map((r) => (r as unknown as { name: string }).name);
    assert.deepEqual(names('skill'), ['Python']);
    assert.deepEqual(names('language'), ['Hindi', 'English']);
  });
});

suite('contact URLs are validated', () => {
  test('bare domains get https://; real URLs pass', () => {
    assert.equal(cleanContactUrl('github.com/anand'), 'https://github.com/anand');
    assert.equal(cleanContactUrl('https://anand.dev'), 'https://anand.dev');
    assert.equal(cleanContactUrl(' anand.dev/work '), 'https://anand.dev/work');
  });
  test('junk and non-http schemes are dropped', () => {
    for (const bad of ['', 'portfolio', 'anand sundar', 'javascript:alert(1)', 'ftp://x.com', 'http://localhost', 'a.b1', 'https://']) {
      assert.equal(cleanContactUrl(bad), null, bad);
    }
  });
  test('a URL that is the email local-part is invented and dropped', () => {
    assert.equal(cleanContactUrl('anand.sundar', 'anand.sundar@gmail.com'), null);
    assert.equal(cleanContactUrl('https://www.Anand.Sundar/', 'anand.sundar@gmail.com'), null);
    assert.equal(cleanContactUrl('anand.sundar', 'other@gmail.com'), 'https://anand.sundar');
  });
  test('import commit path: incoming URLs are cleaned, stored ones are not overwritten', () => {
    const { merged } = fillContactGaps(null, { fullName: 'A', email: 'anand.sundar@gmail.com', portfolioUrl: 'anand.sundar', githubUrl: 'github.com/anand' });
    assert.equal(merged.portfolioUrl, null);
    assert.equal(merged.githubUrl, 'https://github.com/anand');
    const kept = fillContactGaps({ email: 'a@b.com', portfolioUrl: 'mine.example' }, { portfolioUrl: 'other.example' });
    assert.equal(kept.merged.portfolioUrl, 'mine.example');
  });
});

const base = { userId: 'u', source: 'manual' as const, flaggedForRemoval: false, reviewState: 'approved' as const, createdAt: new Date(), updatedAt: new Date() };
const role = (id: string, title: string, start: string, end: string): RoleRecord =>
  ({ id, userId: 'u', title, company: `Co ${id}`, startDate: start, endDate: end, source: 'manual', contentHash: id, reviewState: 'approved' });
const bullet = (id: string, roleId: string, text: string) =>
  ({ ...base, id, type: 'experience-bullet', roleId, text, action: text, tags: [], contentHash: id }) as ProfileRecord;
const contact = { fullName: 'A', email: 'a@x.com' } as never;

await suiteAsync('jobs with no bullets', async () => {
  const roles = [role('new', 'Engineer', '2023-01', 'present'), role('empty', 'Intern', '2022-01', '2022-06'), role('old', 'Analyst', '2020-01', '2021-01')];
  const groupsOf = (doc: ResumeDocument) => doc.sections.find((s) => s.key === 'experience')!.groups!.map((g) => g.title);

  await testAsync('a job with no bullets is left out of the resume', async () => {
    const { document } = await assembleResume({
      userId: 'u', contact, job: null, rewrite: false, roles,
      records: [bullet('b1', 'new', 'Built a thing'), bullet('b2', 'old', 'Analysed a thing')],
    });
    assert.deepEqual(groupsOf(document), ['Engineer', 'Analyst']);
  });

  await testAsync('with no bullets at all the jobs stay rather than print an empty Experience', async () => {
    const { document } = await assembleResume({ userId: 'u', contact, job: null, rewrite: false, roles, records: [] });
    assert.equal(groupsOf(document).length, 3);
  });
});

suite('trailing period', () => {
  test('Latin text gets a period; Devanagari and Tamil do not', () => {
    assert.equal(composeBulletText({ action: 'Shipped the billing rewrite' }), 'Shipped the billing rewrite.');
    assert.equal(composeBulletText({ action: 'Cut latency', outcome: 'by 40%' }), 'Cut latency, by 40%.');
    assert.equal(composeBulletText({ action: 'मैंने बिलिंग सेवा बनाई।' }), 'मैंने बिलिंग सेवा बनाई।');
    assert.equal(composeBulletText({ action: 'मैंने बिलिंग सेवा बनाई' }), 'मैंने बिलिंग सेवा बनाई');
    assert.equal(composeBulletText({ action: 'பில்லிங் சேவையை உருவாக்கினேன்' }), 'பில்லிங் சேவையை உருவாக்கினேன்');
    assert.equal(composeBulletText({ action: 'Launched v2!' }), 'Launched v2!');
  });
});

await suiteAsync('interview evidence is verbatim', async () => {
  const lines = ['Closed deals worth ₹1.2 crore in FY24', 'Built a billing service in Go'];

  await testAsync('verifiedEvidence keeps, repairs or drops', async () => {
    assert.equal(verifiedEvidence('Built a billing service in Go', lines), 'Built a billing service in Go');
    assert.equal(verifiedEvidence('billing  service', lines), 'billing service', 'whitespace collapses; a substring is verbatim');
    assert.equal(verifiedEvidence('Closed deals worth ?1.2 crore in FY24', lines), 'Closed deals worth ₹1.2 crore in FY24');
    assert.equal(verifiedEvidence('Led a team of fifty engineers across Mars', lines), '');
    assert.equal(verifiedEvidence('', lines), '');
  });

  await testAsync('a stub model that corrupts a quote cannot put it on the page', async () => {
    process.env.GROQ_API_KEY = 'placeholder';
    setCooldownBackend(null); resetCooldownCache(); resetBreakers(); setTelemetrySink(null);
    const reply = JSON.stringify({
      questions: [
        { question: 'Tell me about sales', why: 'w', yourEvidence: 'Closed deals worth ?1.2 crore in FY24', category: 'technical' },
        { question: 'Kubernetes?', why: 'w', yourEvidence: 'Ran a 500-node Kubernetes fleet at scale', category: 'gap-probe' },
      ],
    });
    setChainDeps({
      generateObject: (async () => ({ object: JSON.parse(reply), usage: { totalTokens: 5 }, finishReason: 'stop' })) as never,
      generateText: (async () => ({ text: reply, usage: { totalTokens: 5 }, finishReason: 'stop' })) as never,
      resolveModel: ((cfg: { id: string }) => ({ provider: cfg.id })) as never,
    });
    const doc = { id: 'd', userId: 'u', contact: { fullName: 'A Person', email: 'a@x.com' }, sections: [{ heading: 'Experience', items: [{ text: lines[0] }, { text: lines[1] }] }] } as unknown as ResumeDocument;
    const job = { roleTitle: 'Sales', company: 'G', seniority: 'mid', requiredSkills: [], preferredSkills: [], responsibilities: [] } as unknown as JobRequirement;
    const prep = await generateInterviewPrep(doc, job);
    assert.equal(prep.questions[0].yourEvidence, 'Closed deals worth ₹1.2 crore in FY24');
    assert.equal(prep.questions[0].hasEvidence, true);
    assert.equal(prep.questions[1].yourEvidence, '');
    assert.equal(prep.questions[1].hasEvidence, false);
    assert.equal(prep.gapQuestions, 1);
  });
});
