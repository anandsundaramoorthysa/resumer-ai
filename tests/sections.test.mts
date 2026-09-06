/**
 * Section coverage — the sections a resume needs, and the rules about when they appear.
 *
 * This suite exists because of a real failure: the generator built six sections while the
 * profile held twelve kinds of record, so a finished resume came back missing whole
 * sections — publications, languages, volunteering — with nothing anywhere reporting a
 * problem. Every assertion below is the absence of one of those silent drops:
 *
 *   - a section that exists in the profile but never reaches the document
 *   - a section that reaches the document under a heading no parser recognises
 *   - a section built and then lost because a category's order forgot to list it
 *   - a low-value section (Interests) displacing a substantive one
 *   - the relevance floor deleting a record it has no business judging
 *
 * `rewrite: false` throughout: this is about assembly, and the grounded rewrite has its
 * own suite. It also keeps these cases free of a model call.
 */

import { assert, report, suite, suiteAsync, test, testAsync } from './harness.mjs';
import { assembleResume, CONTENT_LINES_PER_PAGE } from '@/lib/generate/assemble';
import { CATEGORY_PROFILES, missingFromSectionOrder } from '@/lib/retrieval/categories';
import { domainFit, rankRecords, RELEVANCE_FLOOR } from '@/lib/retrieval/rank';
import { isAllowedHeading } from '@/lib/render/headings';
import { scoreFormatting } from '@/lib/quality/formatting';
import type {
  ContactInfo,
  JobRequirement,
  ProfileRecord,
  ResumeDocument,
  RoleRecord,
  SectionKey,
} from '@/lib/types';

/* -------------------------------------------------------------- fixtures --- */

let seq = 0;

/** The ProfileRecordBase fields every record needs and no case here cares about. */
function base(tags: string[] = []) {
  seq += 1;
  return {
    id: `r${seq}`,
    userId: 'u1',
    source: 'github-sync' as const,
    contentHash: `h${seq}`,
    tags,
    flaggedForRemoval: false,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };
}

const CONTACT: ContactInfo = {
  fullName: 'Anand Sundaramoorthy',
  email: 'anand@example.com',
  location: 'Chennai, India',
  portfolioUrl: 'anandsundaramoorthy.com',
};

const ROLE: RoleRecord = {
  id: 'role1',
  userId: 'u1',
  title: 'Software Engineer',
  company: 'Acme',
  startDate: '2022-01',
  endDate: 'present',
  source: 'github-sync',
  contentHash: 'rh1',
};

function job(overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    roleTitle: 'Software Engineer',
    seniority: 'mid',
    category: 'general',
    requiredSkills: ['TypeScript'],
    preferredSkills: [],
    responsibilities: [],
    atsKeywords: ['TypeScript', 'React'],
    tone: 'neutral',
    confidence: 0.9,
    flags: [],
    ...overrides,
  };
}

function bullets(n: number): ProfileRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    ...base(['typescript']),
    type: 'experience-bullet' as const,
    roleId: ROLE.id,
    text: `Shipped feature ${i + 1} in TypeScript, cutting page weight`,
    action: 'Shipped',
  }));
}

function projects(n: number): ProfileRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    ...base(['typescript']),
    type: 'project' as const,
    name: `Project ${i + 1}`,
    description: `A TypeScript service doing thing ${i + 1}`,
    stack: ['TypeScript'],
    links: [],
    impactMetrics: [],
  }));
}

/** One record of every new type, plus enough of the old ones to be a real resume. */
function fullProfile(): ProfileRecord[] {
  return [
    {
      ...base(),
      type: 'summary',
      text: 'Engineer who ships TypeScript services and writes about them.',
    },
    { ...base(), type: 'skill', name: 'TypeScript', category: 'language' },
    ...bullets(3),
    ...projects(1),
    {
      ...base(),
      type: 'education',
      institution: 'Loyola College',
      credential: 'B.Sc.',
      field: 'Computer Science',
      endDate: '2021',
    },
    { ...base(), type: 'certification', name: 'AWS Cloud Practitioner', issuer: 'AWS' },
    {
      ...base(),
      type: 'publication',
      title: 'On Retrieval Floors',
      venue: 'SIGIR',
      date: '2024-06',
      doi: '10.1145/3372923',
      status: 'published',
    },
    {
      ...base(),
      type: 'writing',
      title: 'Why Your ATS Drops Your Resume',
      venue: 'Medium',
      date: '2024-08',
    },
    { ...base(), type: 'award', title: 'Best Paper', issuer: 'SIGIR', date: '2024-06' },
    {
      ...base(),
      type: 'achievement',
      title: 'Open source maintainer',
      description: '3k stars',
    },
    {
      ...base(),
      type: 'volunteering',
      role: 'Organiser',
      organization: 'Chennai JS',
      date: '2023',
    },
    { ...base(), type: 'language', name: 'Tamil', proficiency: 'native' },
    { ...base(), type: 'language', name: 'English', proficiency: 'professional' },
    { ...base(), type: 'interest', name: 'Long distance running' },
    { ...base(), type: 'interest', name: 'Chess' },
  ];
}

async function build(records: ProfileRecord[], j: JobRequirement | null = job()) {
  return assembleResume({
    userId: 'u1',
    contact: CONTACT,
    job: j,
    records,
    roles: [ROLE],
    rewrite: false,
  });
}

function section(doc: ResumeDocument, key: SectionKey) {
  return doc.sections.find((s) => s.key === key);
}

/* ------------------------------------------------------------ the suites --- */

suite('section orders', () => {
  test('every category orders every section', () => {
    for (const [category, profile] of Object.entries(CATEGORY_PROFILES)) {
      const missing = missingFromSectionOrder(profile.sectionOrder);
      assert.equal(
        missing.length,
        0,
        `${category} would build and then silently drop: ${missing.join(', ')}`,
      );
      assert.equal(
        new Set(profile.sectionOrder).size,
        profile.sectionOrder.length,
        `${category} lists a section twice`,
      );
    }
  });

  test('summary leads in every category', () => {
    for (const [category, profile] of Object.entries(CATEGORY_PROFILES)) {
      assert.equal(profile.sectionOrder[0], 'summary', `${category} buries the summary`);
    }
  });

  test('each category leads with what its readers scan for', () => {
    const ai = CATEGORY_PROFILES['ai-engineer'].sectionOrder;
    assert(
      ai.indexOf('publications') < ai.indexOf('experience'),
      'a paper is primary evidence for an AI role',
    );
    assert(
      ai.indexOf('projects') < ai.indexOf('experience'),
      'AI hiring reads the portfolio before the job history',
    );

    const pm = CATEGORY_PROFILES['project-manager'].sectionOrder;
    assert.equal(pm[1], 'experience', 'PM resumes lead with experience');
    assert(
      pm.indexOf('volunteering') < pm.indexOf('projects'),
      'leadership outranks side projects for a PM',
    );

    const seo = CATEGORY_PROFILES.seo.sectionOrder;
    assert.equal(seo[2], 'experience', 'SEO resumes lead with experience');
    assert(
      seo.indexOf('publications') < seo.indexOf('projects'),
      'published writing is the SEO portfolio',
    );
  });
});

await suiteAsync('new sections render', async () => {
  const newKeys: SectionKey[] = [
    'summary',
    'publications',
    'awards',
    'volunteering',
    'languages',
    'interests',
  ];

  for (const key of newKeys) {
    await testAsync(`${key} renders with an allow-listed heading`, async () => {
      const { document } = await build(fullProfile());
      const s = section(document, key);
      assert(s, `${key} section is missing from the document`);
      assert(
        isAllowedHeading(key, s!.heading),
        `"${s!.heading}" is not an ATS-recognised heading for ${key}`,
      );
      assert(s!.items.length > 0, `${key} rendered with no items`);
    });
  }

  await testAsync('summary is the first section', async () => {
    const { document } = await build(fullProfile());
    assert.equal(document.sections[0].key, 'summary');
  });

  await testAsync('every item carries its source record id', async () => {
    const { document } = await build(fullProfile());
    const traced: SectionKey[] = ['summary', 'publications', 'awards', 'volunteering'];
    for (const key of traced) {
      for (const item of section(document, key)!.items) {
        assert(item.sourceRecordId, `${key} item lost its traceability id`);
      }
    }
  });

  await testAsync('a full document has no formatting violations', async () => {
    const { document } = await build(fullProfile());
    const { violations } = scoreFormatting(document);
    assert.equal(
      violations.length,
      0,
      `new sections introduced: ${violations.map((v) => `${v.rule} (${v.detail})`).join('; ')}`,
    );
  });
});

await suiteAsync('publications', async () => {
  await testAsync('papers and articles share one section, papers first', async () => {
    const { document } = await build(fullProfile());
    const items = section(document, 'publications')!.items.map((i) => i.text);
    assert.equal(items.length, 2, 'both the paper and the article belong here');
    assert(items[0].includes('On Retrieval Floors'), 'the paper leads');
    assert(items[1].includes('Why Your ATS Drops Your Resume'), 'the article follows');
    assert(
      !document.sections.some((s) => /blog|writing/i.test(s.heading)),
      'writing must not get its own unrecognised heading',
    );
  });

  await testAsync('title, venue, date and DOI are all shown', async () => {
    const { document } = await build(fullProfile());
    const paper = section(document, 'publications')!.items[0].text;
    assert(paper.includes('SIGIR'), 'venue');
    assert(paper.includes('Jun 2024'), 'date, spelled out');
    assert(paper.includes('DOI 10.1145/3372923'), 'DOI');
  });

  await testAsync('an unpublished paper says so', async () => {
    const records: ProfileRecord[] = [
      ...fullProfile().filter((r) => r.type !== 'publication'),
      {
        ...base(),
        type: 'publication',
        title: 'Work In Progress',
        venue: 'arXiv',
        status: 'under-review',
      },
    ];
    const { document } = await build(records);
    const line = section(document, 'publications')!.items[0].text;
    assert(line.includes('Under review'), `status missing from "${line}"`);
  });
});

await suiteAsync('one-line sections', async () => {
  await testAsync('languages render as a single comma-joined line', async () => {
    const { document } = await build(fullProfile());
    const s = section(document, 'languages')!;
    assert.equal(s.items.length, 1, 'one line, not one bullet per language');
    assert.equal(s.items[0].text, 'Tamil (Native), English (Professional)');
  });

  await testAsync('interests render as a single line', async () => {
    const { document } = await build(fullProfile());
    const s = section(document, 'interests')!;
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].text, 'Long distance running, Chess');
  });
});

await suiteAsync('page budget', async () => {
  /** ~26 of the 29 lines a page holds: no headroom left, but not overflowing either. */
  const fullPage = () => [...fullProfile(), ...bullets(5), ...projects(2)];

  /** More content than the page holds however the tail is trimmed. */
  const overflowing = () => [...fullProfile(), ...bullets(8), ...projects(8)];

  await testAsync('a short resume keeps its interests', async () => {
    const { document, droppedForSpace } = await build(fullProfile());
    assert.equal(droppedForSpace.length, 0, `dropped ${droppedForSpace.join(', ')}`);
    assert(section(document, 'interests'), 'interests belong on a short resume');
  });

  await testAsync('interests drop first when the page fills', async () => {
    const { document, droppedForSpace } = await build(fullPage());
    assert.deepEqual(droppedForSpace, ['interests'], 'only interests should go');
    assert(!section(document, 'interests'), 'interests still present');
    assert(section(document, 'languages'), 'languages must outlive interests');
    assert(section(document, 'volunteering'), 'volunteering must outlive interests');
  });

  await testAsync('languages then volunteering follow, in that order', async () => {
    const { document, droppedForSpace } = await build(overflowing());
    assert.deepEqual(droppedForSpace, ['interests', 'languages', 'volunteering']);
    assert(!section(document, 'languages'));
    assert(!section(document, 'volunteering'));
  });

  await testAsync('substance is never dropped for space', async () => {
    const { document } = await build(overflowing());
    const substance: SectionKey[] = [
      'summary',
      'experience',
      'skills',
      'projects',
      'education',
      'certifications',
      'publications',
      'awards',
    ];
    for (const key of substance) {
      assert(section(document, key), `${key} must never be cut for space`);
    }
  });

  await testAsync('two pages of budget keep the same content whole', async () => {
    const { document, droppedForSpace } = await build(
      fullPage(),
      job({ seniority: 'senior' }),
    );
    assert.equal(droppedForSpace.length, 0, `dropped ${droppedForSpace.join(', ')}`);
    assert(section(document, 'interests'), 'a senior resume has room for interests');
  });

  test('the per-page line budget is a plausible page', () => {
    assert(
      CONTENT_LINES_PER_PAGE > 20 && CONTENT_LINES_PER_PAGE < 40,
      'a page holds neither 5 nor 100 lines of content',
    );
  });
});

suite('relevance floor exemptions', () => {
  const seoJob = job({
    category: 'seo',
    roleTitle: 'SEO Specialist',
    requiredSkills: ['technical SEO'],
    atsKeywords: ['technical SEO', 'keyword research'],
  });

  /** Twelve on-domain skills, so the floor is not relaxed away before it is tested. */
  const seoSkills = (): ProfileRecord[] =>
    Array.from({ length: 12 }, (_, i) => ({
      ...base(['seo', 'keyword', 'serp']),
      type: 'skill' as const,
      name: `SEO skill ${i + 1}`,
      category: 'tool' as const,
    }));

  const language: ProfileRecord = {
    ...base(),
    type: 'language',
    name: 'Tamil',
    proficiency: 'native',
  };
  const education: ProfileRecord = {
    ...base(),
    type: 'education',
    institution: 'Loyola College',
    credential: 'B.Sc.',
    field: 'Physics',
  };
  const certification: ProfileRecord = {
    ...base(),
    type: 'certification',
    name: 'First Aid',
    issuer: 'Red Cross',
  };
  const interest: ProfileRecord = { ...base(), type: 'interest', name: 'Chess' };
  const identity = [language, education, certification, interest];

  const offDomain: ProfileRecord = {
    ...base(['kubernetes']),
    type: 'experience-bullet',
    roleId: ROLE.id,
    text: 'Migrated services to Kubernetes across three clusters',
    action: 'Migrated',
  };

  test('these records genuinely score zero domain fit', () => {
    // Without this, the exemption case below could pass for the wrong reason.
    for (const r of identity) {
      assert(
        domainFit(r, seoJob) < RELEVANCE_FLOOR,
        `a ${r.type} scores above the floor here, so the exemption is untested`,
      );
    }
  });

  test('the floor never removes a language, degree, certification or interest', () => {
    const { ranked, excluded } = rankRecords([...seoSkills(), ...identity, offDomain], seoJob);
    const survived = new Set(ranked.map((r) => r.record.id));
    for (const r of identity) {
      assert(
        survived.has(r.id),
        `a ${r.type} was filtered out as "off-domain" for an SEO role`,
      );
    }
    assert(
      excluded.some((r) => r.id === offDomain.id),
      'the floor must still exclude a genuinely off-domain bullet',
    );
  });

  test('exempt records do not count toward floor relaxation', () => {
    // Twelve languages look like twelve survivors, which is exactly the count the
    // relaxation treats as a viable resume. If they counted, the floor would never
    // relax and the only bullet in the profile would be dropped from an empty resume.
    const manyLanguages: ProfileRecord[] = Array.from({ length: 12 }, (_, i) => ({
      ...base(),
      type: 'language' as const,
      name: `Language ${i + 1}`,
    }));
    const { ranked } = rankRecords([...manyLanguages, offDomain], seoJob);
    assert(
      ranked.some((r) => r.record.id === offDomain.id),
      'the floor should have relaxed to zero — there is nothing else to build from',
    );
  });
});

report('sections');
