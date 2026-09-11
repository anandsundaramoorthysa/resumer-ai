/**
 * Reading contact links out of resume text.
 *
 * The case that prompted this is the first suite below: a real resume header where the
 * LinkedIn and GitHub icons became the letters "in" and nothing at all, leaving two
 * identical bare handles that an extraction model quite reasonably left alone.
 *
 * The negative cases matter as much. This runs over the whole document, so an
 * over-eager rule would claim a company's website as the candidate's portfolio or a
 * repository link as a profile — both of which put something on a resume that the person
 * did not write.
 */

import { fillContactGaps, findContactLinks, mergeContactLinks } from '../lib/import/contact-links';
import { suite, test, assert } from './harness.mjs';

/** The real header, as pdf extraction produced it. */
const REAL_HEADER = `Anand S
sanand03072005@gmail.com +91 80124 84177
in anandsundaramoorthysa anandsundaramoorthysa anandsundaramoorthy.com
PROFESSIONAL SUMMARY`;

suite('the header that started this', () => {
  const found = findContactLinks(REAL_HEADER);

  test('the "in" glyph plus a handle becomes a LinkedIn profile', () => {
    assert(
      found.linkedinUrl === 'https://www.linkedin.com/in/anandsundaramoorthysa',
      `got ${found.linkedinUrl}`,
    );
  });

  test('the repeated handle becomes the GitHub profile', () => {
    assert(
      found.githubUrl === 'https://github.com/anandsundaramoorthysa',
      `got ${found.githubUrl}`,
    );
  });

  test('the personal domain is still read as the portfolio', () => {
    assert(found.portfolioUrl === 'anandsundaramoorthy.com', `got ${found.portfolioUrl}`);
  });

  test('the email domain is not mistaken for a website', () => {
    assert(found.portfolioUrl !== 'gmail.com', 'gmail.com came from the address, not a site');
  });
});

suite('explicit urls', () => {
  test('full profile urls are read directly', () => {
    const f = findContactLinks(
      'Contact: https://www.linkedin.com/in/jane-doe-123 and https://github.com/janedoe',
    );
    assert(f.linkedinUrl === 'https://www.linkedin.com/in/jane-doe-123', `got ${f.linkedinUrl}`);
    assert(f.githubUrl === 'https://github.com/janedoe', `got ${f.githubUrl}`);
  });

  test('a url without a scheme still counts', () => {
    const f = findContactLinks('linkedin.com/in/someone · github.com/someone');
    assert(f.linkedinUrl?.endsWith('/someone'), `got ${f.linkedinUrl}`);
    assert(f.githubUrl === 'https://github.com/someone', `got ${f.githubUrl}`);
  });

  test('a repository link is not a profile', () => {
    const f = findContactLinks('Source: https://github.com/someorg/some-project');
    assert(f.githubUrl === undefined, `owner/repo is a project link, got ${f.githubUrl}`);
  });

  test('a trailing full stop is not part of the handle', () => {
    const f = findContactLinks('Find me at github.com/janedoe.');
    assert(f.githubUrl === 'https://github.com/janedoe', `got ${f.githubUrl}`);
  });
});

suite('markers and bare handles', () => {
  test('a named marker claims the token beside it', () => {
    const f = findContactLinks('LinkedIn: jane-doe | GitHub: janedoe');
    assert(f.linkedinUrl?.endsWith('/jane-doe'), `got ${f.linkedinUrl}`);
    assert(f.githubUrl === 'https://github.com/janedoe', `got ${f.githubUrl}`);
  });

  test('an @handle is accepted', () => {
    const f = findContactLinks('GitHub @octocat');
    assert(f.githubUrl === 'https://github.com/octocat', `got ${f.githubUrl}`);
  });

  test('a bare word with no marker is never claimed', () => {
    const f = findContactLinks('Anand S\nDeveloper\nChennai');
    assert(f.linkedinUrl === undefined, 'no LinkedIn without a marker');
    assert(f.githubUrl === undefined, 'no GitHub without a marker');
  });

  test('a handle repeated only once is not assumed to be GitHub', () => {
    // The line carries an email, so it is recognisable as a contact line.
    const f = findContactLinks('jane@example.com · in someperson\nSUMMARY');
    assert(f.linkedinUrl?.endsWith('/someperson'), `LinkedIn from the marker, got ${f.linkedinUrl}`);
    assert(f.githubUrl === undefined, 'one sighting is not two accounts');
  });

  test('a bare "in" on a line with no contact details is ignored', () => {
    // Position is not enough on its own: a fragment with no section heading is all
    // "header", so the line must actually look like a contact line.
    const f = findContactLinks('in someperson\nand then more prose');
    assert(
      f.linkedinUrl === undefined,
      `no email, phone or domain on that line — got ${f.linkedinUrl}`,
    );
  });

  test('the word "in" inside a sentence does not create a profile', () => {
    const f = findContactLinks('Worked in Chennai on distributed systems.');
    assert(
      f.linkedinUrl === undefined,
      `"in Chennai" is prose, not a handle — got ${f.linkedinUrl}`,
    );
  });
});

suite('portfolio detection', () => {
  test('a social host is never the portfolio', () => {
    const f = findContactLinks('linkedin.com/in/jane github.com/jane medium.com/@jane');
    assert(f.portfolioUrl === undefined, `got ${f.portfolioUrl}`);
  });

  test('a personal domain is', () => {
    const f = findContactLinks('jane@example.com · janedoe.dev');
    assert(f.portfolioUrl === 'janedoe.dev', `got ${f.portfolioUrl}`);
  });
});

suite('merging with what the model found', () => {
  test('the model wins wherever it produced a value', () => {
    const merged = mergeContactLinks(
      { linkedinUrl: 'https://linkedin.com/in/model-found', fullName: 'Anand S' },
      { linkedinUrl: 'https://www.linkedin.com/in/scanner-found', githubUrl: 'https://github.com/x' },
    );
    assert(merged.linkedinUrl === 'https://linkedin.com/in/model-found', 'not overwritten');
    assert(merged.githubUrl === 'https://github.com/x', 'and the gap is filled');
  });

  test('an empty string counts as missing', () => {
    const merged = mergeContactLinks(
      { githubUrl: '   ' },
      { githubUrl: 'https://github.com/found' },
    );
    assert(merged.githubUrl === 'https://github.com/found', 'whitespace is not a value');
  });

  test('no contact at all still yields the scanned links', () => {
    const merged = mergeContactLinks(undefined, { githubUrl: 'https://github.com/found' });
    assert(merged.githubUrl === 'https://github.com/found', 'works from nothing');
  });
});

suite('contact details from an extraction fill gaps only', () => {
  const stored = {
    fullName: 'Anand S', email: 'a@example.com', phone: '+91 90000 00000', location: 'Chennai',
    portfolioUrl: null, githubUrl: 'https://github.com/anand', linkedinUrl: null,
  };

  test('a portfolio that states no name or email keeps the stored ones', () => {
    const { merged, changed } = fillContactGaps(stored, { portfolioUrl: 'anand.dev' });
    assert(merged.fullName === 'Anand S' && merged.email === 'a@example.com', 'name and email kept');
    assert(merged.phone === stored.phone && merged.githubUrl === stored.githubUrl, 'phone and links kept');
    assert(merged.portfolioUrl === 'anand.dev' && changed, 'the empty field is filled');
  });

  test('an injected email cannot replace the real one', () => {
    const { merged, changed } = fillContactGaps(stored, { email: 'attacker@evil.test', fullName: '' });
    assert(merged.email === 'a@example.com' && !changed, 'nothing changes');
  });

  test('a first contact block is written whole', () => {
    const { merged, changed } = fillContactGaps(null, { fullName: 'Jane', email: 'j@x.com' });
    assert(merged.fullName === 'Jane' && merged.phone === null && changed, 'written');
  });
});
