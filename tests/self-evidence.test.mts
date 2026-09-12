/**
 * Finding the user's own published words — lib/profile/self-evidence.ts.
 *
 * Three rules decide whether anything off the web may be shown as the user's: the page
 * must be about them, the quote must be on the page, and a rewrite may only use what it
 * cites. Each suite below is one of them.
 */

import {
  buildSearchQuery,
  findSelfEvidence,
  quoteOnPage,
  tiesToPerson,
} from '../lib/profile/self-evidence';
import { groundEmployerRewrite } from '../lib/profile/employer-context';
import { DraftBudget } from '../lib/ai/budget';
import { assert, suite, suiteAsync, test, testAsync } from './harness.mjs';

const ROLE = { title: 'Artificial Intelligence Intern', company: 'DiffuseAi' };
const NAME = 'Anand Sundaramoorthy';

suite('self-evidence — the search', () => {
  test('name and company are phrases; the title is left loose', () => {
    assert.equal(
      buildSearchQuery(NAME, ROLE),
      '"Anand Sundaramoorthy" "DiffuseAi" Artificial Intelligence Intern',
    );
  });

  test('"Self-employed" is not an employer anyone is tied to, so it is not searched', () => {
    assert.equal(
      buildSearchQuery(NAME, { title: 'Freelancer', company: 'Self-employed' }),
      '"Anand Sundaramoorthy" Freelancer',
    );
  });
});

suite('self-evidence — is this page the same person', () => {
  const filler = ' lorem ipsum dolor sit amet'.repeat(40);

  test('the name beside the company ties the page to the person', () => {
    const page = `Posted by Anand Sundaramoorthy · AI Intern at DiffuseAi. Our chatbot answered 2,000 applicants.`;
    assert(tiesToPerson(page, NAME, ROLE) !== null);
  });

  test('a longer spelling of the same name still matches', () => {
    const page = `ANAND SUNDARAMOORTHY SA — worked at DiffuseAi on model integration.`;
    assert(tiesToPerson(page, 'Anand Sundaramoorthy', ROLE) !== null);
  });

  test('the same name at a different company is someone else', () => {
    const page = `Anand Sundaramoorthy, Senior Consultant at Deloitte, spoke about audit tooling.`;
    assert.equal(tiesToPerson(page, NAME, ROLE), null);
  });

  test('the same name with the same job title at another company is someone else', () => {
    // Regression: the title used to be an anchor even when the job had an employer, so a
    // page about a namesake with a common title at a different firm tied on the title alone.
    const page = `Anand Sundaramoorthy, Artificial Intelligence Intern at Google, shared his launch notes.`;
    assert.equal(tiesToPerson(page, NAME, ROLE), null);
  });

  test('a directory with the name at one end and the company at the other ties nothing', () => {
    const page = `Anand Sundaramoorthy, Chennai.${filler} Companies hiring: DiffuseAi, Acme.`;
    assert.equal(tiesToPerson(page, NAME, ROLE), null);
  });

  test('a first name alone is not the person', () => {
    const page = `Anand joined DiffuseAi as an intern.`;
    assert.equal(tiesToPerson(page, NAME, ROLE), null);
  });

  test('for a self-employed job, the title is the anchor', () => {
    const role = { title: 'Freelancer', company: 'Self-employed' };
    assert(tiesToPerson('Anand Sundaramoorthy — freelancer, LinkedIn and SEO work.', NAME, role) !== null);
    assert.equal(tiesToPerson('Anand Sundaramoorthy is self-employed.', NAME, role), null);
  });
});

suite('self-evidence — is the quote really on the page', () => {
  const page = `# Launch week\n\nOur admissions chatbot answered 2,000 applicants\nin its first week, with no staff on call.`;

  test('verbatim, across a line break and a change of case', () => {
    assert(quoteOnPage('Our admissions chatbot answered 2,000 applicants in its first week', page));
    assert(quoteOnPage('OUR ADMISSIONS CHATBOT answered 2,000 applicants', page));
  });

  test('a paraphrase is not a quote', () => {
    assert(!quoteOnPage('The chatbot served 2,000 applicants during launch week', page));
  });

  test('a changed number is not a quote', () => {
    assert(!quoteOnPage('Our admissions chatbot answered 3,000 applicants', page));
  });

  test('a fragment short enough to match by chance does not count', () => {
    assert(!quoteOnPage('first week', page));
  });
});

suite('self-evidence — a rewrite may use only what it cites', () => {
  const bullet = 'Built the admissions chatbot';
  const quote = 'Our admissions chatbot answered 2,000 applicants in its first week';

  test('a figure from a cited quote is the user’s own and needs no company attribution', () => {
    const out = groundEmployerRewrite({
      candidate: 'Built the admissions chatbot, which answered 2,000 applicants in its first week',
      bullet,
      facts: [quote],
    });
    assert.equal(out.text, 'Built the admissions chatbot, which answered 2,000 applicants in its first week');
  });

  test('a word in a quote is not the user’s hedge — the owner’s real case', () => {
    // Found by running this against the owner's profile: the verified quote says "as a
    // Machine Learning Intern", the hedge check read "learning" as the user hedging, and a
    // rewrite that dropped it was refused. Scope is the bullet's alone.
    const out = groundEmployerRewrite({
      candidate: 'Integrated open-source AI models into web applications using Flask during a Machine Learning internship at DiffuseAI',
      bullet: 'Integrated open-source AI models into web applications using Flask.',
      facts: ['In my internship at DiffuseAI as a Machine Learning Intern, I was exposed to real-world applications of AI.'],
    });
    assert(out.text !== null, `refused: ${JSON.stringify(out.violations)}`);
  });

  test('the user’s own hedge still cannot be dropped, whatever the quotes say', () => {
    const out = groundEmployerRewrite({
      candidate: 'Built the admissions chatbot',
      bullet: 'Helped build the admissions chatbot',
      facts: [quote],
    });
    assert.equal(out.text, null);
    assert.deepEqual(out.violations, [{ kind: 'scope', token: 'helped' }]);
  });

  test('the same figure with nothing cited is refused', () => {
    const out = groundEmployerRewrite({
      candidate: 'Built the admissions chatbot, which answered 2,000 applicants in its first week',
      bullet,
      facts: [],
    });
    assert.equal(out.text, null);
    assert(out.violations.some((v) => v.kind === 'number' && v.token === '2,000'));
  });
});

await suiteAsync('self-evidence — degrading without the network', async () => {
  await testAsync('no Firecrawl key: no search, no model call, the question list', async () => {
    const saved = process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    try {
      const budget = new DraftBudget({ maxCalls: 2, maxTokens: 1_000 }, 20_000, 0);
      const out = await findSelfEvidence({
        fullName: NAME,
        role: ROLE,
        bullets: [
          { recordId: 'b1', text: 'Integrated open-source AI models using Flask.', missing: ['scale', 'outcome'] },
          { recordId: 'b2', text: 'Cut model load time by 40% for 3 teams.', missing: [] },
        ],
        budget,
      });
      assert.equal(budget.snapshot().calls, 0, 'no model call was made');
      assert.equal(out.sources.length, 0);
      assert(out.note && /no network/.test(out.note), out.note ?? '');
      assert.equal(out.proposals[0].question, 'How big was this, and what changed because of it?');
      assert.equal(out.proposals[1].question, null, 'a complete bullet is not asked about');
      assert(out.proposals.every((p) => p.after === null));
    } finally {
      if (saved !== undefined) process.env.FIRECRAWL_API_KEY = saved;
    }
  });
});
