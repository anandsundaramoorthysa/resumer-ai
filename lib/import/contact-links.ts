/**
 * Finding LinkedIn, GitHub and website links in resume text, without a model.
 *
 * A real resume header reads:
 *
 *   in anandsundaramoorthysa   anandsundaramoorthysa   anandsundaramoorthy.com
 *
 * Those are three links, and a person reads them instantly: the "in" is a LinkedIn icon
 * whose glyph the PDF extractor rendered as letters, the two identical words are the same
 * handle on LinkedIn and on GitHub, and the third is a personal site. An extraction model
 * caught the website and left both handles null — a fair miss, because nothing about a
 * bare word says which network it belongs to except an icon that is no longer there.
 *
 * So this is deterministic rather than another line in a prompt. The shapes are strict: a
 * full URL, a `linkedin.com/in/...` path, an `@handle`, or a bare handle beside a marker.
 * Deterministic also means testable, which a prompt is not, and free, which matters on a
 * path that already spends a model call per chunk.
 *
 * Nothing here overwrites a value the model did find. It fills gaps.
 */

export interface ContactLinks {
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
}

/** Hosts that are never someone's personal site, so a bare domain match must skip them. */
const NOT_A_PORTFOLIO =
  /^(linkedin|github|gitlab|bitbucket|twitter|x|facebook|instagram|medium|dev|hashnode|leetcode|hackerrank|kaggle|stackoverflow|youtube|behance|dribbble|notion|google|gmail|outlook|yahoo)\./i;

/**
 * A handle is letters, digits and single separators, 3-39 characters.
 *
 * GitHub caps at 39 and LinkedIn's vanity names are similar. The floor of 3 keeps stray
 * words like "in" and "at" out, which matters because the icon glyphs this reads around
 * are exactly such words.
 */
const HANDLE = /^[a-z0-9](?:[a-z0-9]|[-_.](?=[a-z0-9])){1,37}[a-z0-9]$/i;

/**
 * The contact block: everything before the first section heading.
 *
 * Links live at the top of a resume, above SUMMARY or EXPERIENCE. Confining the weakest
 * rule to that region is what separates an icon glyph from ordinary prose — without it,
 * "Worked in Chennai" produces a LinkedIn profile for Chennai, which a test here caught
 * it doing. A resume with no recognisable heading gets the first few hundred characters,
 * which is where a header would be anyway.
 */
function contactHeader(text: string): string {
  const heading =
    /\n\s*(?:PROFESSIONAL\s+SUMMARY|SUMMARY|PROFILE|OBJECTIVE|EDUCATION|EXPERIENCE|WORK\s+EXPERIENCE|EMPLOYMENT|SKILLS|PROJECTS)\b/i.exec(
      text,
    );
  const end = heading ? heading.index : Math.min(text.length, 400);
  return text.slice(0, end);
}

/**
 * Whether a line carries contact details rather than prose.
 *
 * An email address, a run of digits long enough to be a phone number, or a domain. Any
 * one of them is enough — resume headers vary, but they all carry at least one.
 */
function isContactLine(line: string): boolean {
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(line)) return true;
  if (/(?:\+?\d[\d\s\-()]{7,}\d)/.test(line)) return true;
  return /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(line);
}

function normaliseHandle(raw: string): string | null {
  const handle = raw.trim().replace(/^@/, '').replace(/[.,;:)\]]+$/, '');
  return HANDLE.test(handle) ? handle : null;
}

/** Pulls the handle out of a full profile URL, whatever form it was written in. */
function handleFromUrl(url: string, host: 'linkedin' | 'github'): string | null {
  const pattern =
    host === 'linkedin'
      ? /linkedin\.com\/(?:in|pub)\/([^\s/?#]+)/i
      : /github\.com\/([^\s/?#]+)/i;
  const match = pattern.exec(url);
  return match ? normaliseHandle(decodeURIComponent(match[1])) : null;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads links out of the raw text of a resume.
 *
 * Explicit URLs are trusted first. A bare handle is only claimed when a marker naming
 * that network sits immediately before it — a word on its own is never claimed.
 */
export function findContactLinks(text: string): ContactLinks {
  const found: ContactLinks = {};
  const header = contactHeader(text);

  /**
   * Whether this text contains a contact block at all.
   *
   * The importer calls this once per chunk, and only one chunk is the header. Run over
   * the body of a real resume the loose rules produce confident nonsense: "GitHub
   * Actions" became github.com/Actions, "Next.js" became a personal website, and "in
   * page" became a LinkedIn profile. Every one of those is a plausible-looking link
   * attached to somebody's resume that they never wrote.
   *
   * An email address is the reliable marker of a header. Without one, only a complete
   * and unambiguous profile URL is accepted and every inference is skipped.
   */
  const hasContactBlock = /[^\s@]+@[^\s@]+\.[^\s@]+/.test(header);

  // --- 1. Explicit URLs, which need no inference at all. ---------------------------
  const urls =
    text.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?/gi) ?? [];

  for (const raw of urls) {
    const url = raw.replace(/[.,;:)\]]+$/, '');

    if (!found.linkedinUrl) {
      const handle = handleFromUrl(url, 'linkedin');
      if (handle) found.linkedinUrl = `https://www.linkedin.com/in/${handle}`;
    }

    if (!found.githubUrl) {
      // github.com/owner/repo is a project link; only a bare owner is a profile.
      const isRepo = /github\.com\/[^\s/?#]+\/[^\s/?#]/i.test(url);
      const handle = handleFromUrl(url, 'github');
      if (handle && !isRepo) found.githubUrl = `https://github.com/${handle}`;
    }

    if (!found.portfolioUrl && hasContactBlock) {
      const bare = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
      const domain = bare.split('/')[0];
      const isPlainDomain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain);
      // Skip anything that is only the tail of an email address on the page.
      const cameFromEmail = text.includes(`@${domain}`);
      if (isPlainDomain && !NOT_A_PORTFOLIO.test(bare) && !cameFromEmail) {
        found.portfolioUrl = bare;
      }
    }
  }

  // --- 2. A named marker, inside the contact block only. ---------------------------
  //
  // 'GitHub' appears in body text constantly — 'GitHub Actions', 'pushed to GitHub' —
  // and reading the next word as a username produced github.com/Actions from a real
  // resume. The marker only means an account where accounts are listed.
  // The separator is what makes it a label rather than a sentence: a colon, a pipe, a
  // bullet, or an @ starting the handle. "GitHub: janedoe" and "GitHub @octocat" are
  // accounts; "GitHub Actions" and "pushed to GitHub yesterday" are prose, and a plain
  // space between the two is the only thing that told them apart before — which is how a
  // real resume produced github.com/Actions.
  const labelled = (network: string) =>
    new RegExp(`(?:^|[\\s|·•])(?:${network})\\s*(?::|[|·•])\\s*([a-z0-9][a-z0-9\\-_.]{2,38})|(?:^|[\\s|·•])(?:${network})\\s+@([a-z0-9][a-z0-9\\-_.]{2,38})`, 'i');

  if (!found.linkedinUrl) {
    const m = labelled('linkedin|linked-in').exec(text);
    const handle = m ? normaliseHandle(m[1] ?? m[2] ?? '') : null;
    if (handle) found.linkedinUrl = `https://www.linkedin.com/in/${handle}`;
  }

  if (!found.githubUrl) {
    const m = labelled('github|git\\s?hub').exec(text);
    const handle = m ? normaliseHandle(m[1] ?? m[2] ?? '') : null;
    if (handle) found.githubUrl = `https://github.com/${handle}`;
  }

  // --- 3. A bare "in", which is only an icon on a contact line. --------------------
  //
  // Position alone is not enough: a short fragment with no section heading is all
  // "header", and "Worked in Chennai on distributed systems" then yields a LinkedIn
  // profile for Chennai. What actually distinguishes the contact block is that it
  // carries contact details, so the line itself must hold an email, a phone number or a
  // domain before a bare preposition is read as an icon.
  if (!found.linkedinUrl && hasContactBlock) {
    for (const line of header.split('\n')) {
      if (!isContactLine(line)) continue;
      const m = /(?:^|[\s|·•])in[\s:|·•]+([@a-z0-9][a-z0-9\-_.]{2,38})/i.exec(line);
      const handle = m ? normaliseHandle(m[1]) : null;
      if (handle) {
        found.linkedinUrl = `https://www.linkedin.com/in/${handle}`;
        break;
      }
    }
  }

  // --- 4. The same handle twice, which is the case that started this. --------------
  //
  // "in <handle> <handle>" is a LinkedIn icon, a handle, a second icon whose glyph
  // vanished entirely, then the same handle again. Claiming the repeat as GitHub is an
  // inference, so it is made only inside the header and only when GitHub is still
  // unknown — never from a word seen once.
  if (found.linkedinUrl && !found.githubUrl && hasContactBlock) {
    const handle = found.linkedinUrl.split('/').pop();
    if (handle) {
      const escaped = escapeForRegex(handle);
      const repeated = new RegExp(`\\b${escaped}\\b[\\s|·•]+\\b${escaped}\\b`, 'i');
      if (repeated.test(header)) found.githubUrl = `https://github.com/${handle}`;
    }
  }

  return found;
}

/**
 * Fills only what is missing.
 *
 * The model's answer wins wherever it produced one: it read the whole document, this read
 * a pattern. This exists for the fields it left empty, not to second-guess it.
 */
export function mergeContactLinks<T extends ContactLinks>(
  contact: T | undefined,
  found: ContactLinks,
): T & ContactLinks {
  const base = (contact ?? {}) as T;
  return {
    ...base,
    linkedinUrl: base.linkedinUrl?.trim() || found.linkedinUrl,
    githubUrl: base.githubUrl?.trim() || found.githubUrl,
    portfolioUrl: base.portfolioUrl?.trim() || found.portfolioUrl,
  };
}
