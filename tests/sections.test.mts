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
import {
  assembleResume,
  CONTENT_LINES_PER_PAGE,
  distributeBulletsByRecency,
  rolesByRecency,
} from '@/lib/generate/assemble';
import { CATEGORY_PROFILES, missingFromSectionOrder } from '@/lib/retrieval/categories';
import { domainFit, rankRecords, RELEVANCE_FLOOR } from '@/lib/retrieval/rank';
import { isAllowedHeading } from '@/lib/render/headings';
import { scoreFormatting } from '@/lib/quality/formatting';
import type {
  ContactInfo,
  ExperienceBulletRecord,
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
    reviewState: 'approved' as const,
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
  reviewState: 'approved',
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

/**
 * Bullets are written at the length a real one runs to — around twenty words — because
 * the quality gate now measures the document's word count against the page budget
 * (AUDIT #7, `lib/quality/length.ts`). A fixture of five-word bullets is an implausibly
 * thin resume, and the gate would be right to say so.
 */
function bullets(n: number): ProfileRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    ...base(['typescript']),
    type: 'experience-bullet' as const,
    roleId: ROLE.id,
    text: `Shipped feature ${i + 1} in TypeScript, cutting median page weight for the checkout journey and removing two rendering passes from every request`,
    action: 'Shipped',
  }));
}

function projects(n: number): ProfileRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    ...base(['typescript']),
    type: 'project' as const,
    name: `Project ${i + 1}`,
    description: `A TypeScript service doing thing ${i + 1}, built to run unattended, with a job queue, structured logging and a small operator console for replaying failures`,
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
      text: 'Engineer who ships TypeScript services and writes about them, working end to end from schema design through deployment, and happiest on the parts of a system that other people would rather not own.',
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
    // Tagged so it matches the fixture job: certificates and blog posts print only when
    // they match the posting.
    { ...base(['typescript']), type: 'certification', name: 'AWS Cloud Practitioner', issuer: 'AWS' },
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
      ...base(['react']),
      type: 'writing',
      title: 'Why Your ATS Drops Your Resume',
      venue: 'Medium',
      date: '2024-08',
    },
    {
      ...base(),
      type: 'award',
      title: 'Best Paper',
      issuer: 'SIGIR',
      date: '2024-06',
      description: 'Awarded for the retrieval-floor work, out of four hundred submissions',
    },
    {
      ...base(),
      type: 'achievement',
      title: 'Open source maintainer',
      description:
        'Maintain a TypeScript logging library with three thousand stars, reviewing community patches and cutting a release every month',
    },
    {
      ...base(),
      type: 'volunteering',
      role: 'Organiser',
      organization: 'Chennai JS',
      date: '2023',
      description:
        'Run the monthly meetup, find and rehearse the speakers, and keep the venue and catering inside a sponsor budget',
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
    'achievements',
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
      assert(s!.items.length + (s!.groups?.length ?? 0) > 0, `${key} rendered with no items`);
    });
  }

  await testAsync('volunteering is laid out like experience: role, organisation, dates', async () => {
    const { document } = await build(fullProfile());
    const [g] = section(document, 'volunteering')!.groups!;
    assert.equal(g.title, 'Organiser');
    assert.equal(g.subtitle, 'Chennai JS');
    assert.equal(g.dateRange, '2023');
  });

  await testAsync('volunteering sorts newest first, whichever way its dates were written', async () => {
    const vol = (role: string, date: string) =>
      ({ ...base(), type: 'volunteering', role, organization: 'Loyola College', date }) as ProfileRecord;
    const { document } = await build([
      ...fullProfile().filter((r) => r.type !== 'volunteering'),
      vol('Lab Incharge', 'Jul 2023 – Apr 2025'),
      vol('Student Representative', '2025-06 – 2026-04'),
      vol('IIC President', 'Oct 2024 – Apr 2025'),
    ]);
    const groups = section(document, 'volunteering')!.groups!;
    assert.deepEqual(groups.map((g) => g.title), ['Student Representative', 'IIC President', 'Lab Incharge']);
    assert.equal(groups[0].dateRange, 'Jun 2025 – Apr 2026');
  });

  await testAsync('summary is the first section', async () => {
    const { document } = await build(fullProfile());
    assert.equal(document.sections[0].key, 'summary');
  });

  await testAsync('every item carries its source record id', async () => {
    const { document } = await build(fullProfile());
    const traced: SectionKey[] = ['summary', 'publications', 'awards', 'volunteering'];
    for (const key of traced) {
      const s = section(document, key)!;
      for (const item of [...s.items, ...(s.groups ?? []).flatMap((g) => g.items)]) {
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
  // Papers print only when they bear on the job, so these use a posting the fixture's
  // paper ("On Retrieval Floors") is relevant to.
  const researchJob = () => job({ atsKeywords: ['TypeScript', 'React', 'retrieval'] });

  await testAsync('a paper unrelated to the job is left off; blog posts stay', async () => {
    const { document } = await build(fullProfile());
    const items = section(document, 'publications')!.items.map((i) => i.text);
    assert(!items.some((t) => t.includes('On Retrieval Floors')), 'an unrelated paper must not print');
    assert(items.some((t) => t.includes('Why Your ATS Drops Your Resume')), 'blog posts print');
  });

  await testAsync('papers and articles share one section, papers first', async () => {
    const { document } = await build(fullProfile(), researchJob());
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
    const { document } = await build(fullProfile(), researchJob());
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
        title: 'Work In Progress on Retrieval',
        venue: 'arXiv',
        status: 'under-review',
      },
    ];
    const { document } = await build(records, researchJob());
    const line = section(document, 'publications')!.items[0].text;
    assert(line.includes('Under review'), `status missing from "${line}"`);
  });
});

await suiteAsync('one-line sections', async () => {
  await testAsync('spoken languages are the last row of Skills', async () => {
    const { document } = await build(fullProfile());
    assert(!section(document, 'languages'), 'no separate Languages section');
    const rows = section(document, 'skills')!.items.map((i) => i.text);
    assert.equal(rows[rows.length - 1], 'Languages: Tamil (Native), English (Professional)');
  });

  await testAsync('interests render as a single line', async () => {
    const { document } = await build(fullProfile());
    const s = section(document, 'interests')!;
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].text, 'Long distance running, Chess');
  });
});

await suiteAsync('page budget', async () => {
  /**
   * ~26 of the 29 lines a page holds: no headroom left, but not overflowing either.
   *
   * The page is filled with projects rather than more bullets. Since AUDIT #8 the bullet
   * allowance is distributed per role and capped at five for the most recent one, so
   * piling eight bullets onto this fixture's single role no longer produces eight lines —
   * which is the point of that change, and would quietly make this fixture stop testing
   * the page budget at all.
   */
  const fullPage = () => [...fullProfile(), ...bullets(2), ...projects(5)];

  /** More content than the page holds however the tail is trimmed. */
  const overflowing = () => [...fullProfile(), ...bullets(5), ...projects(12)];

  await testAsync('a short resume keeps its interests', async () => {
    const { document, droppedForSpace } = await build(fullProfile());
    assert.equal(droppedForSpace.length, 0, `dropped ${droppedForSpace.join(', ')}`);
    assert(section(document, 'interests'), 'interests belong on a short resume');
  });

  await testAsync('interests drop first when the page fills', async () => {
    const { document, droppedForSpace } = await build(fullPage());
    assert.deepEqual(droppedForSpace, ['interests'], 'only interests should go');
    assert(!section(document, 'interests'), 'interests still present');
    assert(
      section(document, 'skills')!.items.some((i) => i.text.startsWith('Languages:')),
      'the languages row must outlive interests',
    );
    assert(section(document, 'volunteering'), 'volunteering must outlive interests');
  });

  await testAsync('only interests are ever dropped — volunteering and languages always print', async () => {
    const { document, droppedForSpace } = await build(overflowing());
    assert.deepEqual(droppedForSpace, ['interests']);
    assert(section(document, 'volunteering'), 'volunteering prints in every resume');
    assert(section(document, 'skills')!.items.some((i) => i.text.startsWith('Languages:')));
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

  test('a floor that would remove every bullet from a profile full of them relaxes', () => {
    // Observed on the owner’s profile: a posting read as five keywords let twelve
    // on-domain skills make the floor "viable" while all thirteen bullets fell under it,
    // and the resume went out with bare job titles.
    const bullets: ProfileRecord[] = Array.from({ length: 6 }, (_, i) => ({
      ...offDomain,
      id: `bullet-${i}`,
      contentHash: `bullet-${i}`,
      text: `Migrated service ${i + 1} to Kubernetes`,
    }));
    const { ranked } = rankRecords([...seoSkills(), ...bullets], seoJob);
    const kept = ranked.filter((r) => r.record.type === 'experience-bullet').length;
    assert(kept >= 4, `only ${kept} of 6 bullets survived the floor`);
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

/* --------------------------------------------------- bullets by recency ---- */

suite('per-role bullet distribution (AUDIT #8)', () => {
  const role = (
    id: string,
    startDate: string,
    endDate: string,
  ): RoleRecord => ({
    id,
    userId: 'u1',
    title: `Engineer at ${id}`,
    company: id,
    startDate,
    endDate,
    source: 'github-sync',
    contentHash: `h-${id}`,
    reviewState: 'approved',
  });

  const forRole = (roleId: string, n: number): ExperienceBulletRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      ...base(['typescript']),
      type: 'experience-bullet' as const,
      roleId,
      text: `${roleId} bullet ${i + 1}`,
      action: 'Shipped',
    }));

  const counts = (kept: ExperienceBulletRecord[]) => {
    const out: Record<string, number> = {};
    for (const b of kept) out[b.roleId] = (out[b.roleId] ?? 0) + 1;
    return out;
  };

  test('an ongoing role outranks a finished one that started later', () => {
    const current = role('current', '2021-01', 'present');
    const recent = role('recent', '2023-01', '2024-06');
    assert.deepEqual(
      rolesByRecency([recent, current]).map((r) => r.id),
      ['current', 'recent'],
      'a job you still hold is the most recent one you have',
    );
  });

  test('two ongoing roles order by which started later', () => {
    const older = role('older', '2019-01', 'present');
    const newer = role('newer', '2023-05', 'present');
    assert.deepEqual(
      rolesByRecency([older, newer]).map((r) => r.id),
      ['newer', 'older'],
    );
  });

  test('a dateless role sorts last rather than being guessed at', () => {
    const dated = role('dated', '2019-01', '2020-01');
    const undated = role('undated', '', '');
    assert.deepEqual(
      rolesByRecency([undated, dated]).map((r) => r.id),
      ['dated', 'undated'],
    );
  });

  test('the current job gets more bullets than the old internship', () => {
    const current = role('current', '2023-01', 'present');
    const intern = role('intern', '2019-05', '2019-08');
    // The internship's bullets come first, which is what retrieval ordering did to the
    // live profile: relevance put a 2019 internship above the job the person holds.
    const kept = distributeBulletsByRecency(
      [...forRole('intern', 6), ...forRole('current', 6)],
      [intern, current],
      11,
    );
    const n = counts(kept);
    assert.ok(
      n.current > n.intern,
      `current ${n.current} should beat intern ${n.intern}`,
    );
    // Nine, not eleven: two roles cap at five and four. The allowance is a ceiling, not
    // a quota, and the lines it leaves go to the tail sections rather than to a fifth
    // bullet on a three-month internship.
    assert.equal(kept.length, 9);
  });

  test('no role takes more than five, however many it has', () => {
    const only = role('only', '2023-01', 'present');
    const kept = distributeBulletsByRecency(forRole('only', 20), [only], 20);
    assert.equal(kept.length, 5, 'research caps a single role at five bullets');
  });

  test('every role keeps its floor before any role gets a second helping', () => {
    const roles = [
      role('a', '2023-01', 'present'),
      role('b', '2021-01', '2022-12'),
      role('c', '2019-01', '2020-12'),
    ];
    const kept = distributeBulletsByRecency(
      roles.flatMap((r) => forRole(r.id, 5)),
      roles,
      11,
    );
    const n = counts(kept);
    for (const r of roles) assert.ok(n[r.id] >= 2, `${r.id} was starved (${n[r.id]})`);
    assert.ok(n.a > n.c, 'and the newest still leads');
  });

  test('a dateless role loses the taper, never its place on the resume', () => {
    const dated = role('dated', '2023-01', 'present');
    const undated = role('undated', '', '');
    const kept = distributeBulletsByRecency(
      [...forRole('dated', 5), ...forRole('undated', 5)],
      [dated, undated],
      11,
    );
    const n = counts(kept);
    assert.ok(n.undated >= 2, 'an undated job is still a job that happened');
    assert.ok(n.dated > n.undated, 'but it cannot claim to be the current one');
  });

  test('within a role the most relevant bullets are the ones kept', () => {
    const only = role('only', '2023-01', 'present');
    const kept = distributeBulletsByRecency(forRole('only', 8), [only], 11);
    assert.deepEqual(
      kept.map((b) => b.text),
      ['only bullet 1', 'only bullet 2', 'only bullet 3', 'only bullet 4', 'only bullet 5'],
      'recency decides how many, retrieval order decides which',
    );
  });

  test('with no roles at all the allowance is spent flat, as it was before', () => {
    const orphans = forRole('missing-role', 15);
    assert.equal(distributeBulletsByRecency(orphans, [], 11).length, 11);
  });

  test('the assembled Experience section prints newest first', async () => {
    const current = role('current', '2023-01', 'present');
    const old = role('old', '2019-01', '2020-01');
    const { document } = await assembleResume({
      userId: 'u1',
      contact: CONTACT,
      job: job(),
      records: [...fullProfile(), ...forRole('old', 3), ...forRole('current', 3)],
      roles: [old, current],
      rewrite: false,
    });
    const groups = section(document, 'experience')?.groups ?? [];
    assert.deepEqual(
      groups.map((g) => g.subtitle),
      ['current', 'old'],
      'a reader reads down the page',
    );
  });
});

/**
 * A project with no description.
 *
 * `lib/profile/forms.ts` does not mark a project's description required, and `sanitize()`
 * in lib/import/commit.ts omits a blank field rather than storing an empty string — so a
 * real PDF import produced a project row with no `description` key at all. The assembler
 * trusted the declared type and put `undefined` into a resume item; `sanitizeText` in
 * lib/generate/revise.ts then called `.replace` on it and took the entire draft down,
 * after the model work had already been paid for. The error surfaced three layers from
 * its cause as "Cannot read properties of undefined (reading 'replace')".
 */
suiteAsync('a project with no description', () => {
  testAsync('still appears, and contributes no empty item', async () => {
    const project = {
      ...base(['docker']),
      type: 'project' as const,
      name: 'Auto-Dock It',
      stack: ['Python', 'Docker'],
      links: [],
      impactMetrics: [],
    };
    // The shape the importer actually writes: no `description` key whatsoever.
    assert(!('description' in project), 'the fixture must reproduce the missing key');

    const { document } = await build([...fullProfile(), project as unknown as ProfileRecord]);
    const group = section(document, 'projects')?.groups?.find((g) => g.title === 'Auto-Dock It');

    assert(group !== undefined, 'the project belongs on the resume — its name and stack are the point');
    assert.equal(group?.items.length, 0, 'and it contributes no bullet rather than an empty one');
  });

  testAsync('every assembled item carries real text', async () => {
    const project = {
      ...base(['docker']),
      type: 'project' as const,
      name: 'No Description Here',
      stack: ['Go'],
      links: [],
      impactMetrics: ['', '   '],
    };
    const { document } = await build([...fullProfile(), project as unknown as ProfileRecord]);
    for (const s of document.sections) {
      for (const i of s.items) {
        assert.equal(typeof i.text, 'string', `${s.key} item text must be a string`);
      }
      for (const g of s.groups ?? []) {
        assert.equal(typeof g.title, 'string', `${s.key} group title must be a string`);
        for (const i of g.items) {
          assert.equal(typeof i.text, 'string', `${s.key} group item text must be a string`);
          assert(i.text.trim().length > 0, `${s.key} must not carry a blank bullet`);
        }
      }
    }
  });
});
