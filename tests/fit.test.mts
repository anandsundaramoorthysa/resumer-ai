/**
 * The fit check — lib/fit/*.
 *
 * The verdict is written by a model, and a model asked "is this candidate a fit?" leans
 * towards yes. Everything that keeps it honest is deterministic and lives here: which of
 * the posting's terms the profile really holds, the refs a claim must cite, which
 * knockouts survive, the ceiling on the score, the decision to draft or to ask — and the
 * seal that carries the verdict to the next request without letting the browser forge
 * one. Each is pinned without a model call.
 */

// secret-box derives its key from this at call time, so setting it here is enough.
process.env.TOKEN_ENC_KEY = 'fit-test-key-that-is-long-enough-0123456789';

import { suite, test, assert } from './harness.mjs';
import {
  educationStatus,
  gatherFitFacts,
  isRoleTitleTerm,
  yearsOfWork,
} from '../lib/fit/assess';
import {
  AUTO_PROCEED_SCORE,
  appearsInPosting,
  decide,
  groundReport,
  rulesOnlyReport,
  scoreCeiling,
  verdictFor,
  type AgentOutput,
} from '../lib/fit/agent';
import { personaFor } from '../lib/fit/persona';
import {
  ASSESSMENT_TTL_MS,
  AssessmentTokenError,
  openAssessment,
  sealAssessment,
} from '../lib/fit/token';
import { normalizeForMatch } from '../lib/quality/keywords';
import type { JobRequirement, ProfileRecord, RoleRecord } from '../lib/types';

/* ------------------------------------------------------------- fixtures ---- */

const NOW = new Date('2026-09-10T12:00:00Z');

const job: JobRequirement = {
  roleTitle: 'Product Analyst Intern',
  company: 'Electronic Arts (EA) India',
  seniority: 'intern',
  category: 'data',
  requiredSkills: ['SQL', 'R or Python', 'Data Visualization'],
  preferredSkills: [],
  responsibilities: [],
  atsKeywords: ['Product Analyst Intern', 'SQL', 'Python', 'R', 'data visualization'],
  tone: 'corporate',
  confidence: 1,
  flags: [],
};

const base = {
  userId: 'u1',
  source: 'manual' as const,
  flaggedForRemoval: false,
  reviewState: 'approved' as const,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const records: ProfileRecord[] = [
  { ...base, id: 's1', type: 'skill', name: 'Python', category: 'language', tags: ['python'], contentHash: 'h1' },
  {
    ...base, id: 'p1', type: 'project', name: 'Churn model', tags: [], contentHash: 'h2',
    description: 'Built a regression model in Python on a PostgreSQL warehouse',
    stack: ['PostgreSQL'], links: [], impactMetrics: [],
  },
  {
    ...base, id: 'e1', type: 'education', institution: 'University of Madras',
    credential: 'B.Sc.', field: 'Statistics', startDate: '2020-06', endDate: '2023-05',
    tags: [], contentHash: 'h3',
  },
  {
    ...base, id: 'e2', type: 'education', institution: 'Loyola College',
    credential: 'M.Sc.', field: 'Data Science', startDate: '2025-07', endDate: '2027-05',
    tags: [], contentHash: 'h4',
  },
];

const roles: RoleRecord[] = [
  {
    id: 'w1', userId: 'u1', title: 'Freelancer', company: 'Self-employed', startDate: '2025-04',
    endDate: '2026-03', source: 'manual', contentHash: 'r1', reviewState: 'approved',
  },
  {
    // Entirely inside the freelance period — must not add a single month.
    id: 'w2', userId: 'u1', title: 'Analyst Intern', company: 'Acme', startDate: '2025-06',
    endDate: '2025-08', source: 'manual', contentHash: 'r2', reviewState: 'approved',
  },
];

const contact = { fullName: 'A Candidate', email: 'a@example.com', location: 'Chennai, India' };

const facts = gatherFitFacts({ job, records, roles, contact, now: NOW });
const persona = personaFor('data', 'intern');

const JOB_TEXT = `Product Analyst Intern — EA.
Eligibility: students currently pursuing an M.Sc. in Statistics or Mathematics, graduating in 2027.
Skills: SQL, R or Python, data visualization.`;

function agentSays(over: Partial<AgentOutput> = {}): AgentOutput {
  return {
    verdict: 'good',
    score: 70,
    headline: 'You are a solid fit for this internship.',
    summary: 'Your Python work and statistics degree line up with the role.',
    facets: [],
    knockouts: [],
    nextSteps: ['Add a SQL project with a result you can state.'],
    ...over,
  };
}

/* ---------------------------------------------------------------- facts ---- */

suite('what the profile holds — the deterministic facts', () => {
  test('the job title itself is not counted as a skill to hold', () => {
    assert.ok(!facts.skills.some((s) => s.keyword === 'Product Analyst Intern'));
  });

  test('but a one-word skill inside a title is never mistaken for the title', () => {
    assert.equal(isRoleTitleTerm('Python', 'Python Developer'), false);
    assert.equal(isRoleTitleTerm('Analyst Intern', 'Product Analyst Intern'), true);
  });

  test('a held term cites where it is shown — a named skill before a mention', () => {
    const python = facts.skills.find((s) => s.keyword === 'Python')!;
    assert.equal(python.held, true);
    assert.ok(python.evidence?.ref.startsWith('K'), `expected a skill ref, got ${python.evidence?.ref}`);
    assert.equal(python.evidence?.label, 'Python');
  });

  test('the gate’s own matcher decides — PostgreSQL alone does not count as SQL', () => {
    // A documented decision in lib/skills/identity.ts. The fit check may call it
    // adjacent evidence in words; it may not count it as held.
    assert.equal(facts.skills.find((s) => s.keyword === 'SQL')!.held, false);
  });

  test('coverage is held over asked, title excluded', () => {
    assert.equal(facts.skills.length, 4);
    assert.equal(facts.skillsCoveragePct, 1 / 4);
  });

  test('overlapping roles are counted once', () => {
    assert.equal(facts.yearsHeld, 1);
    assert.equal(yearsOfWork(roles, NOW), 1);
  });

  test('education is completed, in progress, or honestly unknown', () => {
    assert.equal(educationStatus('2023-05', NOW), 'completed');
    assert.equal(educationStatus('2027-05', NOW), 'in-progress');
    assert.equal(educationStatus('present', NOW), 'in-progress');
    assert.equal(educationStatus(undefined, NOW), 'unknown');
  });

  test('every ref the digest prints is one a claim can be checked against', () => {
    const printed = [...facts.digest.matchAll(/\[([A-Z]\d+)\]/g)].map((m) => m[1]);
    assert.ok(printed.length > 0);
    for (const ref of printed) assert.ok(facts.refs[ref], `${ref} is printed but not resolvable`);
  });
});

/* ------------------------------------------------------------ grounding ---- */

suite('the agent’s answer is checked, not trusted', () => {
  test('credit that cites a ref which does not exist is withdrawn', () => {
    const report = groundReport(
      agentSays({
        facets: [
          { area: 'education', requirement: 'M.Sc. in Statistics', status: 'meets', evidence: ['Z99'], note: '' },
        ],
      }),
      facts,
      JOB_TEXT,
      persona,
    );
    assert.equal(report.facets[0].status, 'unclear');
    assert.equal(report.facets[0].evidence.length, 0);
  });

  test('a real ref is kept, however the model spells it', () => {
    const ref = facts.skills.find((s) => s.keyword === 'Python')!.evidence!.ref;
    const report = groundReport(
      agentSays({
        facets: [
          { area: 'skills', requirement: 'Python', status: 'meets', evidence: [` ${ref.toLowerCase()} `], note: '' },
        ],
      }),
      facts,
      JOB_TEXT,
      persona,
    );
    assert.equal(report.facets[0].status, 'meets');
    assert.deepEqual(report.facets[0].evidence.map((e) => e.ref), [ref]);
  });

  test('a skills claim with no ref survives only when the deterministic check backs it', () => {
    const report = groundReport(
      agentSays({
        facets: [
          { area: 'skills', requirement: 'Python for analysis', status: 'meets', evidence: [], note: '' },
          { area: 'skills', requirement: 'Tableau dashboards', status: 'meets', evidence: [], note: '' },
        ],
      }),
      facts,
      JOB_TEXT,
      persona,
    );
    assert.equal(report.facets[0].status, 'meets');
    assert.equal(report.facets[0].evidence.length, 1);
    assert.equal(report.facets[1].status, 'unclear');
  });

  test('a knockout the posting really states is kept, and forces a question', () => {
    const report = groundReport(
      agentSays({
        score: 90,
        knockouts: [
          {
            kind: 'degree',
            requirement: 'Currently pursuing an M.Sc. in Statistics or Mathematics',
            reason: 'Your completed degree is a B.Sc.',
          },
        ],
      }),
      facts,
      JOB_TEXT,
      persona,
    );
    assert.equal(report.knockouts.length, 1);
    assert.equal(report.decision, 'ask');
  });

  test('a knockout the posting never mentions is dropped', () => {
    const report = groundReport(
      agentSays({
        knockouts: [{ kind: 'degree', requirement: 'Must hold a PhD from Stanford University', reason: 'invented' }],
      }),
      facts,
      JOB_TEXT,
      persona,
    );
    assert.equal(report.knockouts.length, 0);
  });

  test('living in another city is a question, never a knockout', () => {
    // The first live fit check did exactly this: "in-person at Hyderabad" as a knockout
    // for a candidate in Chennai. The rule stays visible — as unclear, not failed.
    const posting = `${JOB_TEXT}\nThe internship is in-person at the Hyderabad office, three days a week.`;
    const report = groundReport(
      agentSays({
        score: 60,
        knockouts: [
          {
            kind: 'location',
            requirement: 'The internship is in-person at the Hyderabad office',
            reason: 'You live in Chennai.',
          },
        ],
      }),
      facts,
      posting,
      persona,
    );
    assert.equal(report.knockouts.length, 0);
    const location = report.facets.find((f) => f.area === 'location');
    assert.equal(location?.status, 'unclear');
    assert.equal(report.decision, decide(report.score, 0));
  });

  test('a grade rule is never a knockout — the profile has nowhere to record a grade', () => {
    const posting = `${JOB_TEXT}\nMinimum 7 CGPA with no active backlogs.`;
    const report = groundReport(
      agentSays({
        knockouts: [{ kind: 'grade', requirement: 'Minimum 7 CGPA', reason: 'No CGPA is listed.' }],
      }),
      facts,
      posting,
      persona,
    );
    assert.equal(report.knockouts.length, 0);
    assert.ok(report.facets.some((f) => f.area === 'eligibility' && f.status === 'unclear'));
  });

  test('the score cannot exceed what the profile’s coverage allows', () => {
    const report = groundReport(agentSays({ score: 95, verdict: 'strong' }), facts, JOB_TEXT, persona);
    assert.equal(report.score, scoreCeiling(facts.skillsCoveragePct));
    assert.equal(report.verdict, verdictFor(report.score));
  });

  test('a headline rosier than the checked verdict is replaced', () => {
    const report = groundReport(
      agentSays({ score: 95, verdict: 'strong', headline: 'You are a perfect fit!' }),
      facts,
      JOB_TEXT,
      persona,
    );
    assert.notEqual(report.headline, 'You are a perfect fit!');
  });

  test('a headline no rosier than the verdict is the model’s own', () => {
    const report = groundReport(
      agentSays({ score: 40, verdict: 'weak', headline: 'This role asks for a lot you have not done yet.' }),
      facts,
      JOB_TEXT,
      persona,
    );
    assert.equal(report.headline, 'This role asks for a lot you have not done yet.');
    assert.equal(report.source, 'ai');
  });

  test('the posting test tolerates paraphrase but not invention', () => {
    const posting = normalizeForMatch(JOB_TEXT);
    assert.equal(appearsInPosting('pursuing an M.Sc. in Statistics', posting), true);
    assert.equal(appearsInPosting('ten years of Kubernetes', posting), false);
  });
});

/* ------------------------------------------------------------- decision ---- */

suite('draft straight away, or ask first', () => {
  test('a workable score with no knockout proceeds', () => {
    assert.equal(decide(AUTO_PROCEED_SCORE, 0), 'proceed');
    assert.equal(decide(90, 0), 'proceed');
  });

  test('below the line, it asks', () => {
    assert.equal(decide(AUTO_PROCEED_SCORE - 1, 0), 'ask');
  });

  test('any knockout asks, however high the score', () => {
    assert.equal(decide(100, 1), 'ask');
  });

  test('verdict bands', () => {
    assert.equal(verdictFor(80), 'strong');
    assert.equal(verdictFor(65), 'good');
    assert.equal(verdictFor(45), 'partial');
    assert.equal(verdictFor(44), 'weak');
  });

  test('the rules-only fallback never claims to have checked eligibility', () => {
    const report = rulesOnlyReport(facts, persona);
    assert.equal(report.knockouts.length, 0);
    assert.equal(report.source, 'rules');
    assert.ok(report.skills.missing.includes('SQL'));
  });

  test('the fallback charges for experience the posting asks for and the profile lacks', () => {
    const needsYears = { ...facts, yearsRequired: 5 };
    assert.ok(rulesOnlyReport(needsYears, persona).score < rulesOnlyReport(facts, persona).score);
  });
});

/* -------------------------------------------------------------- persona ---- */

suite('who judges the fit', () => {
  test('an analytics internship is judged by someone who hires interns', () => {
    assert.match(personaFor('data', 'intern').title, /campus/i);
  });

  test('a senior engineering role is judged by an engineering manager', () => {
    assert.match(personaFor('full-stack', 'senior').title, /engineering manager/i);
  });

  test('every category and stage has a persona', () => {
    for (const c of ['seo', 'full-stack', 'ai-engineer', 'project-manager', 'data', 'design', 'general'] as const) {
      for (const s of ['intern', 'mid'] as const) {
        assert.ok(personaFor(c, s).brief.length > 40);
      }
    }
  });
});

/* ---------------------------------------------------------------- token ---- */

suite('the sealed assessment', () => {
  const fit = rulesOnlyReport(facts, persona);

  test('round-trips for the account it was issued to', () => {
    const opened = openAssessment(sealAssessment('u1', job, fit, NOW.getTime()), 'u1', NOW.getTime());
    assert.deepEqual(opened.job, job);
    assert.equal(opened.fit.score, fit.score);
  });

  test('a hand-written, unsealed assessment is refused — the check that makes it a seal', () => {
    // decryptSecret passes non-encrypted values through unchanged, by design, for an old
    // plaintext column. Without the explicit shape check this would be accepted.
    const forged = JSON.stringify({ v: 1, userId: 'u1', issuedAt: NOW.getTime(), job, fit: { ...fit, decision: 'proceed' } });
    assert.throws(() => openAssessment(forged, 'u1', NOW.getTime()), AssessmentTokenError);
  });

  test('an altered token is refused', () => {
    const token = sealAssessment('u1', job, fit, NOW.getTime());
    const parts = token.split('.');
    const body = parts[3];
    parts[3] = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    assert.throws(() => openAssessment(parts.join('.'), 'u1', NOW.getTime()), AssessmentTokenError);
  });

  test('another account’s token is refused', () => {
    const token = sealAssessment('u1', job, fit, NOW.getTime());
    assert.throws(() => openAssessment(token, 'u2', NOW.getTime()), /different account/);
  });

  test('an expired token is refused', () => {
    const token = sealAssessment('u1', job, fit, NOW.getTime() - ASSESSMENT_TTL_MS - 1);
    assert.throws(() => openAssessment(token, 'u1', NOW.getTime()), /expired/);
  });

  test('a token from the future is refused', () => {
    const token = sealAssessment('u1', job, fit, NOW.getTime() + 10 * 60_000);
    assert.throws(() => openAssessment(token, 'u1', NOW.getTime()), /expired/);
  });

  test('anything that is not a string is refused cleanly', () => {
    assert.throws(() => openAssessment(undefined, 'u1'), AssessmentTokenError);
    assert.throws(() => openAssessment({ v: 1 }, 'u1'), AssessmentTokenError);
  });
});
