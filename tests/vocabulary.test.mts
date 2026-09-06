/**
 * Guards the single most consequential comparison in the app: whether the profile
 * genuinely evidences a keyword.
 *
 * These cases are not hypothetical. Every "must NOT hold" below was observed on a real
 * generated resume — "developers" was printed as a skill, alongside eight SEO tools the
 * profile had no entry for, because the old check also tested keyword.includes(term).
 */

import { holdsKeyword, textHoldsKeyword } from '../lib/quality/vocabulary';
import { suite, test, assert } from './harness.mjs';

suite('vocabulary', () => {
  test('exact match holds', () => {
    assert(holdsKeyword(['React', 'TypeScript'], 'react'), 'react should be held');
    assert(holdsKeyword(['Google Analytics 4'], 'Google Analytics 4'), 'exact phrase');
  });

  test('profile may be MORE specific than the keyword', () => {
    assert(
      holdsKeyword(['Advanced Technical SEO'], 'technical SEO'),
      'a more specific profile entry contains the keyword phrase',
    );
    assert(holdsKeyword(['Next.js App Router'], 'Next.js'), 'framework with qualifier');
  });

  test('profile may NOT be less specific than the keyword — the regression', () => {
    assert(
      !holdsKeyword(['SEO'], 'technical SEO'),
      'knowing SEO is not evidence of technical SEO',
    );
    assert(
      !holdsKeyword(['dev', 'development'], 'developers'),
      '"developers" was printed on a real resume from exactly this',
    );
    assert(
      !holdsKeyword(['Analytics'], 'Google Analytics 4'),
      'generic analytics is not GA4',
    );
    assert(!holdsKeyword(['Frog'], 'Screaming Frog'), 'partial tool name');
    assert(!holdsKeyword(['schema'], 'schema markup'), 'partial phrase');
  });

  test('a long title cannot vouch for a word inside it — the second regression', () => {
    assert(
      !holdsKeyword(['ChatGPT Prompt Engineering for Developers'], 'developers'),
      'a certification title is not evidence of every word it contains',
    );
    assert(
      !holdsKeyword(['Bachelor of Engineering in Computer Science'], 'engineering'),
      'a degree title is not a skill called engineering',
    );
    assert(
      holdsKeyword(['Prompt Engineering'], 'prompt engineering'),
      'a genuinely matching short entry still holds',
    );
  });

  test('word boundaries are respected', () => {
    assert(!holdsKeyword(['Java'], 'JavaScript'), 'Java must not hold JavaScript');
    assert(!holdsKeyword(['JavaScript'], 'Java'), 'JavaScript must not hold Java');
    assert(holdsKeyword(['React, Redux, Node'], 'redux'), 'comma-separated list');
  });

  test('empty and junk input holds nothing', () => {
    assert(!holdsKeyword([], 'react'), 'empty vocabulary');
    assert(!holdsKeyword(['React'], ''), 'empty keyword');
    assert(!holdsKeyword(['   '], 'react'), 'whitespace-only entry');
  });

  test('textHoldsKeyword uses the same rule', () => {
    const skills = 'React, TypeScript, PostgreSQL, Google Analytics 4';
    assert(textHoldsKeyword(skills, 'PostgreSQL'), 'present skill');
    assert(textHoldsKeyword(skills, 'google analytics 4'), 'case-insensitive phrase');
    assert(!textHoldsKeyword(skills, 'MySQL'), 'absent skill');
    assert(!textHoldsKeyword(skills, 'Postgres'), 'abbreviation is not the full name');
  });

  test('no job keyword can be claimed from an unrelated stack', () => {
    // The real profile: a web developer with no SEO tooling entries.
    const profile = [
      'React', 'TypeScript', 'Next.js', 'Node.js', 'Express.js',
      'PostgreSQL', 'Python', 'Flask', 'HTML', 'CSS', 'Tailwind CSS',
    ];
    const seoKeywords = [
      'technical SEO', 'Screaming Frog', 'Sitebulb', 'Core Web Vitals',
      'Google Analytics 4', 'Search Console', 'schema markup', 'indexation',
      'organic traffic', 'site audits', 'developers',
    ];
    for (const kw of seoKeywords) {
      assert(
        !holdsKeyword(profile, kw),
        `"${kw}" must not be claimable from a plain web stack`,
      );
    }
    // ...while the stack's own skills still register.
    assert(holdsKeyword(profile, 'HTML'), 'HTML is genuinely held');
  });
});
