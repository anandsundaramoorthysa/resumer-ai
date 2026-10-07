/**
 * Deterministic-scorer unit tests — task 7.12, design.md §6.
 *
 * Three of the four quality sub-scores are pure code (REQ-5.2), which is the only reason
 * the README can claim they "can't hallucinate". That claim is worth exactly as much as
 * the evidence behind it, so every formatting rule gets two tests: one proving it fires
 * on a document that breaks it, and one proving it stays silent on a document that
 * doesn't. A rule that fires on everything is as useless as one that never fires, and
 * only the pair of tests can tell those apart.
 */

import { assert, report, suite, test } from './harness.mjs';
import { scoreKeywordCoverage, KEYWORD_GATE_THRESHOLD } from '@/lib/quality/keywords';
import { scoreFormatting } from '@/lib/quality/formatting';
import { combinedFormattingScore, scoreLength } from '@/lib/quality/length';
import { scoreSkillsCompleteness, profileVocabulary } from '@/lib/quality/skills';
import { evidenceLines, GRADE_VALUE, scoreFromGrades } from '@/lib/quality/evidence';
import type {
  JobRequirement,
  ProfileRecord,
  ResumeDocument,
  ResumeSection,
} from '@/lib/types';

/* ------------------------------------------------------------- fixtures ---- */

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
    ...recordBase, id: 's1', type: 'skill', name: 'PostgreSQL', category: 'tool',
    tags: ['postgresql', 'sql'], contentHash: 'h1',
  },
  {
    ...recordBase, id: 's2', type: 'skill', name: 'React', category: 'framework',
    tags: ['react'], contentHash: 'h2',
  },
  {
    ...recordBase, id: 's3', type: 'skill', name: 'TypeScript', category: 'language',
    tags: ['typescript'], contentHash: 'h3',
  },
  {
    ...recordBase, id: 'p1', type: 'project', name: 'Ledger', description: 'Billing tool',
    stack: ['Docker'], links: [], impactMetrics: [], tags: ['billing'], contentHash: 'h4',
  },
];

const job: JobRequirement = {
  roleTitle: 'Senior Full Stack Engineer',
  company: 'Acme',
  seniority: 'senior',
  category: 'full-stack',
  requiredSkills: ['React', 'TypeScript'],
  preferredSkills: ['Docker'],
  responsibilities: ['ship features'],
  atsKeywords: ['React', 'TypeScript', 'PostgreSQL', 'Kubernetes'],
  tone: 'startup',
  confidence: 0.9,
  flags: [],
};

/**
 * A resume of a plausible length, because the quality gate now measures that (AUDIT #7).
 * The three-line document this fixture used to be is not a resume anyone would send, and
 * the length cases below need something realistic to vary from.
 *
 * The order of the first two entries is load-bearing: cases index `sections[0]` for
 * Skills and `sections[1]` for Experience, so the padding sections go after them. None of
 * the added text mentions a job keyword — the coverage cases count matches exactly, and a
 * stray "TypeScript" in the Summary would silently rewrite their arithmetic.
 */
function cleanSections(): ResumeSection[] {
  return [
    {
      key: 'skills',
      heading: 'Skills',
      items: [{ text: 'React, TypeScript, PostgreSQL', sourceRecordId: null }],
    },
    {
      key: 'experience',
      heading: 'Experience',
      items: [],
      groups: [
        {
          title: 'Engineer',
          subtitle: 'Acme',
          dateRange: 'Jan 2022 – Present',
          items: [
            {
              text: 'Rebuilt the checkout flow in React, cutting p95 latency 40%.',
              sourceRecordId: 'b1',
            },
          ],
        },
        {
          title: 'Junior Engineer',
          subtitle: 'Sparks',
          dateRange: 'Jun 2020 – Mar 2021',
          items: [
            {
              text: 'Took over the internal admin tool nobody owned and cut its unhandled error rate by half over a quarter, mostly by deleting code.',
              sourceRecordId: 'b4',
            },
            {
              text: 'Wrote the first regression suite for the ordering service, which caught two defects in its first week and has run on every commit since.',
              sourceRecordId: 'b5',
            },
          ],
        },
        {
          title: 'Software Engineer',
          subtitle: 'Corizo',
          dateRange: 'Apr 2021 – Dec 2021',
          items: [
            {
              text: 'Rewrote the nightly settlement job so a failed batch could be replayed from the last good record instead of from the start of the day.',
              sourceRecordId: 'b2',
            },
            {
              text: 'Moved report generation off the request path onto a queue, which took the slowest page in the admin console from a timeout to under two seconds.',
              sourceRecordId: 'b3',
            },
          ],
        },
      ],
    },
    {
      key: 'summary',
      heading: 'Summary',
      items: [
        {
          text: 'Engineer who works end to end, from schema design through deployment and the on-call rota that follows it. Happiest on the parts of a system nobody else wants to own: the batch jobs, the migrations, and the reporting that everyone depends on and nobody has looked at in a year.',
          sourceRecordId: 'sm1',
        },
      ],
    },
    {
      key: 'projects',
      heading: 'Projects',
      items: [],
      groups: [
        {
          title: 'Ledger',
          subtitle: 'Billing',
          items: [
            {
              text: 'A double-entry billing service that reconciles against the payment provider every hour and files a report on anything it cannot explain.',
              sourceRecordId: 'p1',
            },
          ],
        },
        {
          title: 'Harbour',
          subtitle: 'Data',
          items: [
            {
              text: 'A schema-diffing tool that refuses a migration whose down path has never been run, after one release spent a weekend being unpicked by hand.',
              sourceRecordId: 'p3',
            },
          ],
        },
        {
          title: 'Cormorant',
          subtitle: 'Tooling',
          items: [
            {
              text: 'A small operator console for replaying failed background work, built after the third outage that turned out to be one stuck queue nobody could see.',
              sourceRecordId: 'p2',
            },
          ],
        },
      ],
    },
    {
      key: 'education',
      heading: 'Education',
      items: [
        {
          text: 'B.Sc. Computer Science, Loyola College, Chennai — graduated with distinction',
          sourceRecordId: 'e1',
        },
      ],
    },
  ];
}

function doc(overrides: Partial<ResumeDocument> = {}): ResumeDocument {
  return {
    id: 'd1',
    userId: 'u1',
    contact: {
      fullName: 'Anand Sundaramoorthy',
      email: 'anand@example.com',
      phone: '+91 90000 00000',
      location: 'Chennai, India',
      portfolioUrl: 'anandsundaramoorthy.com',
    },
    sections: cleanSections(),
    jobRequirement: job,
    renderMode: 'ats-strict',
    recordHashSnapshot: ['h1'],
    createdAt: new Date('2024-06-01'),
    ...overrides,
  };
}

/** Every formatting test compares against this: the clean document fires nothing. */
function rules(d: ResumeDocument): string[] {
  return [...new Set(scoreFormatting(d).violations.map((v) => v.rule))].sort();
}

/* -------------------------------------------------------------- keywords ---- */

suite('keyword coverage (REQ-5.1)', () => {
  test('counts a keyword present verbatim in the document', () => {
    const r = scoreKeywordCoverage(doc());
    assert.ok(r.matched.includes('React'));
    assert.ok(r.matched.includes('PostgreSQL'));
  });

  test('reports a keyword that genuinely is not there', () => {
    const r = scoreKeywordCoverage(doc());
    assert.deepEqual(r.missing, ['Kubernetes']);
  });

  test('coverage is matched/total, exactly', () => {
    const r = scoreKeywordCoverage(doc());
    assert.equal(r.coveragePct, 3 / 4);
  });

  test('passes the gate at 75% coverage, above the 70% threshold', () => {
    const r = scoreKeywordCoverage(doc());
    assert.equal(KEYWORD_GATE_THRESHOLD, 0.7);
    assert.equal(r.passed, true);
  });

  test('fails the gate when coverage drops below the threshold', () => {
    const d = doc();
    d.sections[0].items[0].text = 'React';
    d.sections[1].groups![0].items[0].text = 'Rebuilt the checkout flow.';
    const r = scoreKeywordCoverage(d);
    assert.equal(r.coveragePct, 1 / 4);
    assert.equal(r.passed, false);
  });

  test('matches a plural against a singular keyword and back', () => {
    const d = doc({
      jobRequirement: { ...job, atsKeywords: ['integration', 'pipelines'] },
    });
    d.sections[0].items[0].text = 'Built integrations and one pipeline';
    const r = scoreKeywordCoverage(d);
    assert.deepEqual(r.missing, []);
  });

  test('matches across hyphen/space and dotted spelling differences', () => {
    const d = doc({
      jobRequirement: { ...job, atsKeywords: ['CI-CD', 'Node.js'] },
    });
    d.sections[0].items[0].text = 'CI CD, Nodejs';
    const r = scoreKeywordCoverage(d);
    assert.deepEqual(r.missing, []);
  });

  test('does not credit an unrelated term', () => {
    const d = doc({ jobRequirement: { ...job, atsKeywords: ['Salesforce'] } });
    const r = scoreKeywordCoverage(d);
    assert.deepEqual(r.matched, []);
    assert.equal(r.coveragePct, 0);
  });

  test('a baseline resume with no job attached passes vacuously (REQ-6.7)', () => {
    const r = scoreKeywordCoverage(doc({ jobRequirement: null }));
    assert.equal(r.passed, true);
    assert.equal(r.coveragePct, 1);
    assert.deepEqual(r.missing, []);
  });
});

/* ------------------------------------------------------------ formatting ---- */

suite('formatting compliance (REQ-5.2 / REQ-6.1)', () => {
  test('a compliant document violates no rule and scores 1', () => {
    const result = scoreFormatting(doc());
    assert.deepEqual(
      result.violations,
      [],
      `expected no violations, got ${JSON.stringify(result.violations)}`,
    );
    assert.equal(result.score, 1);
  });

  // --- heading-allow-list ---------------------------------------------------
  test('fires: a creative section heading', () => {
    const d = doc();
    d.sections[1].heading = 'My Journey';
    assert.ok(rules(d).includes('heading-allow-list'));
  });

  test('does not fire: an approved synonym from the allow-list', () => {
    const d = doc();
    d.sections[1].heading = 'Professional Experience';
    d.sections[0].heading = 'Technical Skills';
    assert.deepEqual(rules(d), []);
  });

  // --- skills-section-required ----------------------------------------------
  test('fires: no skills section at all', () => {
    const d = doc();
    d.sections = d.sections.filter((s) => s.key !== 'skills');
    assert.ok(rules(d).includes('skills-section-required'));
  });

  test('fires: a skills section that exists but is empty', () => {
    const d = doc();
    d.sections[0].items = [];
    assert.ok(rules(d).includes('skills-section-required'));
  });

  test('does not fire: a populated skills section', () => {
    assert.ok(!rules(doc()).includes('skills-section-required'));
  });

  // --- contact-in-body ------------------------------------------------------
  test('fires: missing email', () => {
    const d = doc();
    d.contact.email = '';
    assert.ok(rules(d).includes('contact-in-body'));
  });

  test('fires: missing name', () => {
    const d = doc();
    d.contact.fullName = '   ';
    assert.ok(rules(d).includes('contact-in-body'));
  });

  test('does not fire: name and email both present', () => {
    assert.ok(!rules(doc()).includes('contact-in-body'));
  });

  // --- hyperlink-visible-text -----------------------------------------------
  test('fires: a link stored as a label instead of a URL', () => {
    const d = doc();
    d.contact.githubUrl = 'my GitHub';
    assert.ok(rules(d).includes('hyperlink-visible-text'));
  });

  test('does not fire: a bare readable domain', () => {
    const d = doc();
    d.contact.githubUrl = 'github.com/anand';
    d.contact.linkedinUrl = 'linkedin.com/in/anand';
    assert.deepEqual(rules(d), []);
  });

  // --- no-icon-glyphs -------------------------------------------------------
  test('fires: an emoji in a bullet', () => {
    const d = doc();
    d.sections[1].groups![0].items[0].text = '📧 Rebuilt the checkout flow in React.';
    assert.ok(rules(d).includes('no-icon-glyphs'));
  });

  test('fires: an icon glyph in a group title', () => {
    const d = doc();
    d.sections[1].groups![0].title = '💼 Engineer';
    assert.ok(rules(d).includes('no-icon-glyphs'));
  });

  test('does not fire: ordinary punctuation, symbols and accented text', () => {
    const d = doc();
    d.sections[1].groups![0].items[0].text =
      'Grew ARR 40% (€1.2M → €1.7M) for Zoë & Co. — see the write-up.';
    assert.ok(!rules(d).includes('no-icon-glyphs'));
  });

  // --- plain-bullet-chars ---------------------------------------------------
  test('fires: a decorative bullet character in the text', () => {
    const d = doc();
    d.sections[1].groups![0].items[0].text = '★ Rebuilt the checkout flow in React.';
    assert.ok(rules(d).includes('plain-bullet-chars'));
  });

  test('does not fire: the plain bullet and hyphen the renderers use', () => {
    const d = doc();
    d.sections[1].groups![0].items[0].text =
      '• Rebuilt the checkout flow - end-to-end - in React.';
    assert.ok(!rules(d).includes('plain-bullet-chars'));
  });

  // --- spelled-out-dates ----------------------------------------------------
  test('fires: a locale-ambiguous numeric date range', () => {
    const d = doc();
    d.sections[1].groups![0].dateRange = '01/2022 – 05/2024';
    assert.ok(rules(d).includes('spelled-out-dates'));
  });

  test('fires: a numeric date inside a bullet, not just in a date field', () => {
    const d = doc();
    d.sections[1].groups![0].items[0].text = 'Shipped the rewrite on 5/1/09.';
    assert.ok(rules(d).includes('spelled-out-dates'));
  });

  test('does not fire: spelled-out months, or a plain percentage', () => {
    const d = doc();
    d.sections[1].groups![0].dateRange = 'Jan 2022 – May 2024';
    d.sections[1].groups![0].items[0].text = 'Cut p95 latency 40% across 12 services.';
    assert.ok(!rules(d).includes('spelled-out-dates'));
  });

  // --- no-tabular-layout ----------------------------------------------------
  test('fires: a tab character leaking a column layout into content', () => {
    const d = doc();
    d.sections[0].items[0].text = 'React\tTypeScript\tPostgreSQL';
    assert.ok(rules(d).includes('no-tabular-layout'));
  });

  test('fires: a pipe-delimited table row', () => {
    const d = doc();
    d.sections[1].groups![0].items[0].text = '| React | TypeScript |';
    assert.ok(rules(d).includes('no-tabular-layout'));
  });

  test('does not fire: a comma-separated skills line', () => {
    assert.ok(!rules(doc()).includes('no-tabular-layout'));
  });

  // --- presentation-mode-not-for-ats ---------------------------------------
  test('fires: a presentation-mode document scored as an ATS submission (REQ-6.2)', () => {
    assert.ok(
      rules(doc({ renderMode: 'presentation' })).includes(
        'presentation-mode-not-for-ats',
      ),
    );
  });

  test('does not fire: the ats-strict default', () => {
    assert.ok(!rules(doc()).includes('presentation-mode-not-for-ats'));
  });

  // --- scoring arithmetic ---------------------------------------------------
  test('one repeated mistake costs the same as one single mistake', () => {
    const once = doc();
    once.sections[1].groups![0].items[0].text = '★ one';

    const thrice = doc();
    thrice.sections[1].groups![0].items = [
      { text: '★ one', sourceRecordId: null },
      { text: '★ two', sourceRecordId: null },
      { text: '★ three', sourceRecordId: null },
    ];

    assert.equal(scoreFormatting(once).score, scoreFormatting(thrice).score);
    assert.ok(scoreFormatting(thrice).violations.length > 1);
  });

  test('each additional distinct rule broken lowers the score', () => {
    const one = doc();
    one.sections[1].groups![0].items[0].text = '★ one';

    const two = doc();
    two.sections[1].groups![0].items[0].text = '★ one';
    two.sections[1].heading = 'My Journey';

    assert.ok(scoreFormatting(two).score < scoreFormatting(one).score);
    assert.ok(scoreFormatting(one).score < 1);
  });
});

/* ---------------------------------------------------------------- length ---- */

suite('document length (AUDIT #7)', () => {
  test('a resume of a plausible length is not flagged', () => {
    assert.equal(scoreLength(doc()).violation, undefined);
  });

  test('fires: a resume too thin to judge anything by', () => {
    const d = doc({ sections: [cleanSections()[0], cleanSections()[1]] });
    d.sections[1].groups = [d.sections[1].groups![0]];
    const r = scoreLength(d);
    assert.ok(r.violation, `${r.words} words should have been flagged`);
    assert.equal(r.violation?.rule, 'plausible-length');
  });

  test('the floor sits between the resume the audit saw and the research target', () => {
    // The observed failure was ~180 words; research asks for 350-450 on one page. A floor
    // that misses the first or fires on the second would be the wrong number.
    // Fourteen words to a line, which is roughly what a resume bullet runs to — spreading
    // the same word count one-per-line would trip the upper bound instead and prove
    // nothing about the floor.
    const words = (n: number) =>
      doc({
        sections: [
          cleanSections()[0],
          {
            key: 'experience',
            heading: 'Experience',
            items: Array.from({ length: Math.ceil(n / 14) }, (_, i) => ({
              text: Array.from({ length: 14 }, (_, w) => `word${i}x${w}`).join(' '),
              sourceRecordId: null,
            })),
          },
        ],
      });
    assert.ok(scoreLength(words(180)).violation, '180 words must be flagged');
    assert.equal(scoreLength(words(350)).violation, undefined, '350 words must not be');
  });

  test('fires: a resume that overruns its page budget', () => {
    const long = doc();
    long.sections[1].groups![0].items = Array.from({ length: 200 }, (_, i) => ({
      text: `Shipped a thing that mattered to somebody, number ${i}`,
      sourceRecordId: null,
    }));
    const r = scoreLength(long);
    assert.equal(r.violation?.rule, 'plausible-length');
    assert.ok(r.violation?.detail.includes('overruns'));
  });

  test('a two-page-worthy posting gets two pages of budget', () => {
    const mid = doc({ jobRequirement: { ...job, seniority: 'entry' } });
    // 30, not 40: the clean fixture's own bullets are 100-140 characters and wrap to two
    // printed lines (lib/quality/length.ts estimatedLines), so 40 more genuinely overflow two pages.
    mid.sections[1].groups![0].items = Array.from({ length: 30 }, (_, i) => ({
      text: `Shipped a thing that mattered to somebody, number ${i}`,
      sourceRecordId: null,
    }));
    assert.ok(scoreLength(mid).violation, 'this overruns one page');

    const senior = { ...mid, jobRequirement: { ...job, seniority: 'senior' as const } };
    assert.equal(scoreLength(senior).violation, undefined, 'and fits two');
  });

  test('a baseline resume with no posting is not judged for length (REQ-6.7)', () => {
    const tiny = doc({ jobRequirement: null });
    tiny.sections = [cleanSections()[0]];
    assert.equal(scoreLength(tiny).violation, undefined);
  });

  test('an empty document is charged once, by has-substance, not twice', () => {
    const empty = doc({ sections: [] });
    assert.ok(rules(empty).includes('has-substance'));
    assert.equal(scoreLength(empty).violation, undefined);
  });

  test('length costs exactly one formatting rule, no more and no less', () => {
    const clean = scoreFormatting(doc());
    const good = combinedFormattingScore(clean, scoreLength(doc()));
    assert.equal(good, 1);

    const short = { words: 10, lines: 2, violation: { rule: 'plausible-length', detail: '' } };
    assert.equal(combinedFormattingScore(clean, short), 10 / 11);

    // One broken formatting rule and a bad length cost the same as each other.
    const oneRule = doc();
    oneRule.sections[1].heading = 'My Journey';
    assert.equal(
      combinedFormattingScore(scoreFormatting(oneRule), scoreLength(doc())),
      10 / 11,
    );
  });
});

/* ---------------------------------------------------------------- skills ---- */

suite('skills completeness (REQ-5.2, weight 0.40)', () => {
  test('vocabulary covers tags, skill names and project stacks', () => {
    const vocab = profileVocabulary(records);
    assert.ok(vocab.has('postgresql'));
    assert.ok(vocab.has('react'));
    assert.ok(vocab.has('docker'), 'a project stack entry is claimable');
    assert.ok(!vocab.has('kubernetes'));
  });

  test('a keyword in the skills section counts as present', () => {
    const r = scoreSkillsCompleteness(doc(), records);
    assert.ok(r.present.includes('React'));
    assert.ok(r.present.includes('TypeScript'));
  });

  test('a held keyword missing from the skills section is fixable, not a gap', () => {
    const d = doc();
    d.sections[0].items[0].text = 'React, TypeScript';
    const r = scoreSkillsCompleteness(d, records);
    assert.ok(r.missingButHeld.includes('PostgreSQL'));
    assert.ok(!r.genuineGaps.includes('PostgreSQL'));
    assert.equal(r.score, 2 / 3);
  });

  test('a keyword the user does not have is a genuine gap and costs nothing', () => {
    const r = scoreSkillsCompleteness(doc(), records);
    assert.deepEqual(r.genuineGaps, ['Kubernetes']);
    assert.equal(r.score, 1, 'not possessing a skill must not lower the score');
  });

  test('surfacing every held keyword scores a full 1', () => {
    const d = doc();
    d.sections[0].items[0].text = 'React, TypeScript, PostgreSQL, Docker';
    assert.equal(scoreSkillsCompleteness(d, records).score, 1);
  });

  test('surfacing none of them scores 0, without inventing the gap', () => {
    const d = doc();
    d.sections[0].items[0].text = 'Excel';
    const r = scoreSkillsCompleteness(d, records);
    assert.equal(r.score, 0);
    assert.equal(r.present.length, 0);
    assert.deepEqual(r.genuineGaps, ['Kubernetes']);
  });

  test('a baseline resume with no job attached scores 1', () => {
    const r = scoreSkillsCompleteness(doc({ jobRequirement: null }), records);
    assert.equal(r.score, 1);
  });

  test('an empty profile turns every keyword into a genuine gap, and scores 0 (not a free 1.0)', () => {
    const r = scoreSkillsCompleteness(doc({ sections: [cleanSections()[1]] }), []);
    assert.equal(r.present.length, 0);
    assert.equal(r.missingButHeld.length, 0);
    assert.equal(r.genuineGaps.length, 4);
    // Holding none of the posting's skills must not be rewarded: otherwise stuffing a
    // posting's terms into Skills, or having no profile, would max the heaviest sub-score.
    assert.equal(r.score, 0);
  });
});

/* -------------------------------------------------------------- evidence ---- */

suite('evidence arithmetic (REQ-5.2, weight 0.30)', () => {
  test('grades only Experience and Projects lines — never the summary', () => {
    const lines = evidenceLines(doc());
    assert.equal(lines.length, 8); // 5 bullets + 3 project lines
    assert.ok(lines.every((l) => l.sectionKey === 'experience' || l.sectionKey === 'projects'));
    assert.deepEqual(lines.slice(0, 2).map((l) => l.id), ['L1', 'L2']);
  });

  test('specific-but-unmeasured lines score above duties and below outcomes', () => {
    const lines = evidenceLines(doc());
    const all = (grade: 'strong' | 'partial' | 'weak') =>
      scoreFromGrades(lines, lines.map((l) => ({ id: l.id, grade, problem: '' }))).score;
    assert.equal(all('weak'), 0);
    assert.equal(all('strong'), 1);
    assert.ok(Math.abs(all('partial') - GRADE_VALUE.partial) < 1e-9);
    // The bar this weight is chosen against: no outcome anywhere cannot clear 8.5, even
    // with formatting and skills perfect.
    assert.ok((0.3 + 0.4 + 0.3 * GRADE_VALUE.partial) * 10 < 8.5);
  });

  test('an ungraded line counts as weak, and weak lines carry our text, not the model echo', () => {
    const lines = evidenceLines(doc());
    const r = scoreFromGrades(lines, [{ id: 'l1', grade: 'strong', problem: '' }]);
    assert.equal(r.score, 1 / lines.length);
    assert.equal(r.weakBullets.length, lines.length - 1);
    assert.equal(r.weakBullets[0].text, lines[1].text);
    assert.equal(r.weakBullets[0].sectionKey, 'experience');
  });

  test('a line a revision already failed on is scored but not reported again', () => {
    const lines = evidenceLines(doc());
    const grades = lines.map((l) => ({ id: l.id, grade: 'weak' as const, problem: 'no result' }));
    const r = scoreFromGrades(lines, grades, [lines[0].text]);
    assert.equal(r.score, 0);
    assert.ok(!r.weakBullets.some((w) => w.text === lines[0].text));
    assert.equal(r.weakBullets.length, lines.length - 1);
  });
});

report('scorers');
