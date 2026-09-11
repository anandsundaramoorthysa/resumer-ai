/**
 * Reading a LinkedIn data export.
 *
 * This is the safe answer to "import my LinkedIn". Scraping a profile — even the user's
 * own, even from their own browser session — is what puts an account at risk, and the
 * risk falls on the user rather than on us. LinkedIn's own export ("Settings → Data
 * privacy → Get a copy of your data") hands over the same facts as CSV files, with the
 * user's explicit consent, through a supported route, and it includes the sections that
 * a profile page hides behind "show more" — which is exactly where the scraping approach
 * broke down anyway.
 *
 * There is no AI anywhere in this file. A CSV export has named columns; asking a model
 * to read one would introduce a paraphrase where none is needed, and paraphrase is how a
 * profile ends up asserting something the user never wrote. Every string below is
 * carried through verbatim.
 *
 * Position descriptions matter most. The GitHub sync could never fill the Experience
 * section because a portfolio repo states what someone worked on and not what changed
 * as a result; the LinkedIn export carries whatever the user wrote about each job, which
 * is the missing evidence.
 */

import { suggestedSkillCategory } from '@/lib/skills/categories';
import { parseCsv, pick, type CsvRow } from './csv';
import { hashContent } from '@/lib/sync/reconcile';
import { deriveTags } from '@/lib/sync/tags';
import { describeRecord } from '@/lib/profile/forms';
import { dedupeRoles, type RoleLike } from '@/lib/sync/roles';

export interface LinkedInCandidate {
  key: string;
  type: string;
  label: string;
  detail?: string;
  record: Record<string, unknown>;
}

export interface LinkedInRoleCandidate {
  key: string;
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  bullets: LinkedInCandidate[];
}

export interface LinkedInPreview {
  contact: Record<string, string | undefined> | null;
  roles: LinkedInRoleCandidate[];
  records: LinkedInCandidate[];
  totalCount: number;
  /** Export files that were read, by their name in the archive. */
  filesRead: string[];
  /** Files the archive did not contain, so the absence is explained rather than silent. */
  filesMissing: string[];
  notes: string[];
}

/**
 * The export files this reads, by the base name LinkedIn uses. Several have been renamed
 * over the years, so each entry lists every spelling seen; the archive is matched on
 * base name only, since exports are sometimes nested in a dated folder.
 */
const WANTED: Record<string, string[]> = {
  profile: ['profile'],
  positions: ['positions'],
  education: ['education'],
  skills: ['skills'],
  certifications: ['certifications'],
  languages: ['languages'],
  projects: ['projects'],
  publications: ['publications'],
  honors: ['honors', 'awards'],
  volunteering: ['volunteering', 'volunteering experiences', 'volunteerexperiences'],
  courses: ['courses'],
  emails: ['email addresses', 'emailaddresses'],
  phones: ['phonenumbers', 'phone numbers'],
  interests: ['interests'],
};

function baseName(path: string): string {
  const last = path.split(/[\\/]/).pop() ?? path;
  return last.replace(/\.csv$/i, '').trim().toLowerCase();
}

/** Groups the archive's members by the export section each one is. */
export function classifyFiles(names: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of names) {
    if (!/\.csv$/i.test(name)) continue;
    const base = baseName(name);
    for (const [key, spellings] of Object.entries(WANTED)) {
      if (found.has(key)) continue;
      if (spellings.some((s) => s.replace(/\s+/g, '') === base.replace(/\s+/g, ''))) {
        found.set(key, name);
      }
    }
  }
  return found;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * "Mar 2024", "2024-03-01" and "2024" all become "2024-03" or "2024".
 *
 * The export is not consistent: positions use "Mar 2024", education uses a bare year,
 * certifications use a full date. The renderer formats whatever it is given, so an
 * unconverted "Mar 2024" would appear on the resume beside a "2024-03" — the kind of
 * inconsistency an ATS date parser reads as two different formats.
 */
export function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (!s) return '';

  const iso = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}`;

  const monthYear = /^([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(s);
  if (monthYear) {
    const m = MONTHS[monthYear[1].slice(0, 3).toLowerCase()];
    if (m) return `${monthYear[2]}-${m}`;
  }

  const year = /^(\d{4})$/.exec(s);
  if (year) return year[1];

  const slashed = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (slashed) return `${slashed[2]}-${slashed[1].padStart(2, '0')}`;

  return s;
}

/**
 * A job description split into resume bullets.
 *
 * LinkedIn stores it as free text: sometimes one paragraph, usually a list written with
 * "•", "-" or plain newlines. Lines are kept verbatim — only the list marker is removed,
 * because the renderer draws its own.
 */
export function splitDescription(text: string): string[] {
  if (!text.trim()) return [];

  const lines = text
    .split(/\r?\n+/)
    .map((l) => l.replace(/^\s*[•▪◦*\-–—]\s*/, '').trim())
    .filter((l) => l.length > 0);

  // A single long paragraph is one bullet, not a sentence-per-bullet split: cutting on
  // full stops mangles "e.g." and abbreviations, and a wrong split changes the user's
  // words, which is the one thing this file must not do.
  return lines.filter((l) => l.length >= 3).slice(0, 12);
}

function candidate(
  type: string,
  data: Record<string, unknown>,
  hashParts: string[],
  detail?: string,
): LinkedInCandidate {
  const contentHash = hashContent(hashParts);
  return {
    key: `${type}:${contentHash}`,
    type,
    label: describeRecord(type, data) || type,
    detail: detail?.trim() || undefined,
    record: {
      ...data,
      type,
      source: 'linkedin',
      contentHash,
      tags: deriveTags(Object.values(data).filter((v) => typeof v === 'string').join(' ')),
    },
  };
}

/** Reads the decoded CSV text of each export file into review candidates. */
export function buildLinkedInPreview(files: Map<string, string>): LinkedInPreview {
  const classified = classifyFiles([...files.keys()]);
  const text = (key: string): string => {
    const name = classified.get(key);
    return name ? (files.get(name) ?? '') : '';
  };
  const rows = (key: string): CsvRow[] => {
    const t = text(key);
    return t ? parseCsv(t) : [];
  };

  const notes: string[] = [];
  const records: LinkedInCandidate[] = [];

  // --- Contact and summary -------------------------------------------------------
  const profile = rows('profile')[0] ?? {};
  const firstName = pick(profile, 'First Name');
  const lastName = pick(profile, 'Last Name');
  const summaryText = pick(profile, 'Summary');
  const headline = pick(profile, 'Headline');
  const websites = pick(profile, 'Websites');

  const email = pick(rows('emails')[0] ?? {}, 'Email Address');
  const phone = pick(rows('phones')[0] ?? {}, 'Number', 'Phone Number');

  const contact =
    firstName || lastName || email
      ? {
          fullName: [firstName, lastName].filter(Boolean).join(' '),
          email,
          phone: phone || undefined,
          location: pick(profile, 'Geo Location', 'Location') || undefined,
          // Websites are exported as "[STANDARD:https://…]" — the bracketed label is a
          // LinkedIn artefact and would render as part of the URL on the resume.
          portfolioUrl: extractFirstUrl(websites) || undefined,
        }
      : null;

  if (summaryText) {
    records.push(candidate('summary', { text: summaryText }, ['summary', summaryText]));
  } else if (headline) {
    notes.push(
      'Your export has a headline but no About section, so no summary was proposed — a headline is a job title, not a summary.',
    );
  }

  // --- Positions: the reason this import exists ----------------------------------
  const positionRows = rows('positions');
  const roleLikes: Array<RoleLike & { description: string }> = positionRows.map((r) => ({
    title: pick(r, 'Title'),
    company: pick(r, 'Company Name'),
    location: pick(r, 'Location') || undefined,
    startDate: normalizeDate(pick(r, 'Started On', 'Start Date')),
    endDate: normalizeDate(pick(r, 'Finished On', 'End Date')) || 'present',
    description: pick(r, 'Description'),
  }));

  // Descriptions have to be re-attached after dedupe, because two rows for one job each
  // carry their own text and merging must not drop either.
  const descriptionsByRole = new Map<string, string[]>();
  for (const r of roleLikes) {
    if (!r.title && !r.company) continue;
    const key = roleKeyOf(r);
    const list = descriptionsByRole.get(key) ?? [];
    if (r.description) list.push(r.description);
    descriptionsByRole.set(key, list);
  }

  const deduped = dedupeRoles(roleLikes.filter((r) => r.title || r.company));
  if (deduped.length < roleLikes.length) {
    notes.push(
      `${roleLikes.length - deduped.length} position row${roleLikes.length - deduped.length === 1 ? '' : 's'} described a job already listed, and ${roleLikes.length - deduped.length === 1 ? 'was' : 'were'} merged.`,
    );
  }

  const roles: LinkedInRoleCandidate[] = deduped.map((role) => {
    const roleHash = hashContent(['role', role.company, role.title, role.startDate]);
    const descriptions = descriptionsByRole.get(roleKeyOf(role)) ?? [];

    const seen = new Set<string>();
    const bullets: LinkedInCandidate[] = [];
    for (const description of descriptions) {
      for (const line of splitDescription(description)) {
        if (seen.has(line)) continue;
        seen.add(line);
        bullets.push(
          candidate(
            'experience-bullet',
            // roleId holds the role's hash until the role becomes a real row, which is
            // the convention lib/import/commit.ts already expects.
            { roleId: roleHash, text: line, action: line },
            ['bullet', role.company, line],
          ),
        );
      }
    }

    return {
      key: roleHash,
      title: role.title,
      company: role.company,
      startDate: role.startDate,
      endDate: role.endDate,
      bullets,
    };
  });

  const rolesWithoutText = roles.filter((r) => r.bullets.length === 0).length;
  if (rolesWithoutText > 0) {
    notes.push(
      `${rolesWithoutText} of your ${roles.length} positions has no description in the export, so ${rolesWithoutText === 1 ? 'it brings' : 'they bring'} no accomplishments with ${rolesWithoutText === 1 ? 'it' : 'them'}. You can write those on the profile page.`,
    );
  }

  // --- Everything else -----------------------------------------------------------
  for (const r of rows('skills')) {
    const name = pick(r, 'Name');
    if (!name) continue;
    // The export does not say what kind of skill it is. The classifier answers for most
    // names (lib/skills/categories.ts); 'tool' stays the neutral bucket for the rest,
    // and the profile page can change either.
    const category = suggestedSkillCategory(name) ?? 'tool';
    records.push(candidate('skill', { name, category }, ['skill', name, category]));
  }

  for (const r of rows('education')) {
    const institution = pick(r, 'School Name');
    if (!institution) continue;
    const credential = pick(r, 'Degree Name');
    records.push(
      candidate(
        'education',
        {
          institution,
          credential,
          field: pick(r, 'Field Of Study') || undefined,
          startDate: normalizeDate(pick(r, 'Start Date', 'Started On')) || undefined,
          endDate: normalizeDate(pick(r, 'End Date', 'Finished On')) || undefined,
        },
        ['education', institution, credential],
      ),
    );
  }

  for (const r of rows('certifications')) {
    const name = pick(r, 'Name');
    if (!name) continue;
    const issuer = pick(r, 'Authority', 'Issuer');
    records.push(
      candidate(
        'certification',
        {
          name,
          issuer,
          issuedDate: normalizeDate(pick(r, 'Started On', 'Issued On')) || undefined,
          credentialUrl: pick(r, 'Url') || undefined,
        },
        ['cert', name, issuer],
      ),
    );
  }

  for (const r of rows('languages')) {
    const name = pick(r, 'Name');
    if (!name) continue;
    records.push(
      candidate(
        'language',
        { name, proficiency: mapProficiency(pick(r, 'Proficiency')) },
        ['language', name],
      ),
    );
  }

  for (const r of rows('projects')) {
    const name = pick(r, 'Title', 'Name');
    if (!name) continue;
    const description = pick(r, 'Description');
    const url = pick(r, 'Url');
    records.push(
      candidate(
        'project',
        { name, description, stack: [], links: url ? [url] : [], impactMetrics: [] },
        ['project', name, description, ''],
        description,
      ),
    );
  }

  for (const r of rows('publications')) {
    const title = pick(r, 'Name', 'Title');
    if (!title) continue;
    records.push(
      candidate(
        'publication',
        {
          title,
          venue: pick(r, 'Publisher', 'Publication'),
          date: normalizeDate(pick(r, 'Published On')) || undefined,
          url: pick(r, 'Url') || undefined,
          status: 'published',
        },
        ['publication', title],
        pick(r, 'Description'),
      ),
    );
  }

  for (const r of rows('honors')) {
    const title = pick(r, 'Title', 'Name');
    if (!title) continue;
    records.push(
      candidate(
        'award',
        {
          title,
          issuer: pick(r, 'Issuer', 'Issued By') || undefined,
          date: normalizeDate(pick(r, 'Issued On')) || undefined,
          description: pick(r, 'Description') || undefined,
        },
        ['award', title],
        pick(r, 'Description'),
      ),
    );
  }

  for (const r of rows('volunteering')) {
    const organization = pick(r, 'Company Name', 'Organization');
    const role = pick(r, 'Role');
    if (!organization && !role) continue;
    records.push(
      candidate(
        'volunteering',
        {
          role,
          organization,
          date: normalizeDate(pick(r, 'Started On', 'Start Date')) || undefined,
          description: pick(r, 'Description') || undefined,
        },
        ['volunteering', organization, role],
        pick(r, 'Cause') || pick(r, 'Description'),
      ),
    );
  }

  // Courses are proposed as achievements rather than certifications: a course listed on
  // LinkedIn is coursework, and calling it a certification claims a credential that the
  // export gives no evidence of.
  for (const r of rows('courses')) {
    const name = pick(r, 'Name');
    if (!name) continue;
    records.push(
      candidate('achievement', { title: name, description: 'Coursework' }, ['achievement', name]),
    );
  }

  for (const r of rows('interests')) {
    const name = pick(r, 'Name', 'Interest');
    if (!name) continue;
    records.push(candidate('interest', { name }, ['interest', name]));
  }

  // A record can appear twice within one export — the same skill under two sections.
  const unique = new Map<string, LinkedInCandidate>();
  for (const c of records) if (!unique.has(c.key)) unique.set(c.key, c);

  const filesRead = [...classified.values()];
  const filesMissing = Object.keys(WANTED).filter((k) => !classified.has(k));

  if (filesRead.length === 0) {
    notes.push(
      'No recognised LinkedIn export files were found in that archive. The download you want is "Get a copy of your data" with the larger set of files selected, not the profile PDF.',
    );
  }

  const list = [...unique.values()];
  return {
    contact,
    roles,
    records: list,
    totalCount: list.length + roles.reduce((n, r) => n + r.bullets.length, 0),
    filesRead,
    filesMissing,
    notes,
  };
}

function roleKeyOf(role: RoleLike): string {
  return `${role.company}::${role.title}`.toLowerCase();
}

function extractFirstUrl(websites: string): string {
  const match = /(https?:\/\/[^\s,\]]+)/.exec(websites);
  return match ? match[1] : '';
}

/** LinkedIn's proficiency words are not the ones the resume renderer knows. */
function mapProficiency(raw: string): string | undefined {
  const s = raw.toLowerCase();
  if (s.includes('native') || s.includes('bilingual')) return 'native';
  if (s.includes('full professional')) return 'fluent';
  if (s.includes('professional')) return 'professional';
  if (s.includes('limited') || s.includes('conversational')) return 'conversational';
  if (s.includes('elementary')) return 'basic';
  return undefined;
}
