/**
 * The LinkedIn data-export importer.
 *
 * Two things are being pinned here. The first is that the parsers are not naive: a job
 * description containing commas, quotes and newlines is a single field, and an archive
 * is read through its central directory rather than by guessing at offsets. The second
 * is that nothing is invented — every string that reaches a candidate is one that was
 * in the file.
 */

import { deflateRawSync } from 'node:zlib';
import { parseCsv, parseCsvRows, pick } from '../lib/import/csv';
import { readZip, NotAZipError } from '../lib/import/zip';
import {
  buildLinkedInPreview,
  classifyFiles,
  normalizeDate,
  splitDescription,
} from '../lib/import/linkedin';
import { suite, test, assert } from './harness.mjs';

/* ------------------------------------------------------------------ zip ---- */

/** Builds a real archive, so the reader is tested against the format, not a stub. */
function makeZip(files: Array<[string, string]>, compress = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const raw = Buffer.from(content, 'utf8');
    const body = compress ? deflateRawSync(raw) : raw;
    const method = compress ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // CRC is not checked by the reader
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);

  return Buffer.concat([localBlock, centralBlock, eocd]);
}

suite('zip reading', () => {
  test('a deflated archive round-trips', () => {
    const zip = makeZip([['Skills.csv', 'Name\nTypeScript\n']]);
    const entries = readZip(zip);
    assert(entries.length === 1, `one entry, got ${entries.length}`);
    assert(entries[0].name === 'Skills.csv', 'name preserved');
    assert(entries[0].bytes.toString('utf8').includes('TypeScript'), 'content preserved');
  });

  test('a stored (uncompressed) archive round-trips', () => {
    const entries = readZip(makeZip([['Profile.csv', 'First Name\nAnand\n']], false));
    assert(entries[0].bytes.toString('utf8').includes('Anand'), 'stored entries are read too');
  });

  test('several members are all read, in order', () => {
    const entries = readZip(
      makeZip([
        ['Positions.csv', 'a'],
        ['Education.csv', 'b'],
        ['Skills.csv', 'c'],
      ]),
    );
    assert(entries.length === 3, `expected 3, got ${entries.length}`);
    assert(entries.map((e) => e.name).join(',') === 'Positions.csv,Education.csv,Skills.csv', 'order kept');
  });

  test('a file that is not an archive is refused by name', () => {
    let err: unknown = null;
    try {
      readZip(Buffer.from('this is a pdf, honestly'.repeat(10)));
    } catch (e) {
      err = e;
    }
    assert(err instanceof NotAZipError, 'reported as not-a-zip rather than crashing');
  });

  test('directory entries are skipped', () => {
    const entries = readZip(makeZip([['Basic_Profile/', ''], ['Basic_Profile/Skills.csv', 'Name\nSQL\n']]));
    assert(entries.length === 1, `only the file, got ${entries.map((e) => e.name).join(',')}`);
  });
});

/* ------------------------------------------------------------------ csv ---- */

suite('csv parsing', () => {
  test('a quoted field keeps its commas', () => {
    const rows = parseCsvRows('a,b\n"one, two",three\n');
    assert(rows[1][0] === 'one, two', `got ${JSON.stringify(rows[1])}`);
    assert(rows[1][1] === 'three', 'and the next field is intact');
  });

  test('a quoted field keeps its newlines — the case that breaks a naive split', () => {
    const rows = parseCsvRows('Title,Description\nEngineer,"Did a thing\nDid another thing"\n');
    assert(rows.length === 2, `one header and one row, got ${rows.length}`);
    assert(rows[1][1].split('\n').length === 2, 'the description is one field of two lines');
  });

  test('a doubled quote is a literal quote', () => {
    const rows = parseCsvRows('a\n"she said ""hello"""\n');
    assert(rows[1][0] === 'she said "hello"', `got ${JSON.stringify(rows[1][0])}`);
  });

  test('a byte-order mark does not become part of the first header', () => {
    const rows = parseCsv('﻿Name\nTypeScript\n');
    assert(pick(rows[0], 'Name') === 'TypeScript', 'the first column is still findable');
  });

  test('headers are matched however they are spelled', () => {
    const rows = parseCsv('Company Name,Started On\nAcme,Mar 2024\n');
    assert(pick(rows[0], 'company name') === 'Acme', 'case-insensitive');
    assert(pick(rows[0], 'Start Date', 'Started On') === 'Mar 2024', 'falls through to the second name');
  });

  test('a trailing newline does not create an empty row', () => {
    assert(parseCsv('a\n1\n\n').length === 1, 'one data row');
  });
});

/* ------------------------------------------------------------- mapping ---- */

suite('export field mapping', () => {
  test('the date formats the export mixes all normalise', () => {
    assert(normalizeDate('Mar 2024') === '2024-03', 'month name and year');
    assert(normalizeDate('2024-03-01') === '2024-03', 'full ISO date');
    assert(normalizeDate('2024') === '2024', 'bare year is left as a year');
    assert(normalizeDate('') === '', 'empty stays empty');
    assert(normalizeDate('Sometime in 2019') === 'Sometime in 2019', 'anything unrecognised is passed through, not guessed at');
  });

  test('a description becomes one bullet per line, markers removed', () => {
    const bullets = splitDescription('• Built the thing\n- Shipped it\n\nMaintained it');
    assert(bullets.length === 3, `expected 3, got ${JSON.stringify(bullets)}`);
    assert(bullets[0] === 'Built the thing', 'the bullet character is dropped');
    assert(bullets[1] === 'Shipped it', 'so is a hyphen marker');
  });

  test('a paragraph is one bullet — sentences are never split apart', () => {
    const text = 'Led the migration to Postgres, i.e. from MySQL. It cut query time.';
    const bullets = splitDescription(text);
    assert(bullets.length === 1, `one bullet, got ${bullets.length}`);
    assert(bullets[0] === text, 'and the words are exactly as written');
  });

  test('export files are recognised under their several names', () => {
    const found = classifyFiles([
      'Basic_Profile/Profile.csv',
      'Positions.csv',
      'Volunteering Experiences.csv',
      'Honors.csv',
      'Recommendations_Received.csv',
      'photo.jpg',
    ]);
    assert(found.get('profile') === 'Basic_Profile/Profile.csv', 'nested paths are matched on base name');
    assert(found.has('volunteering'), 'the older volunteering spelling is recognised');
    assert(found.has('honors'), 'honors map to awards');
    assert(!found.has('recommendations'), 'recommendations are deliberately not imported');
  });
});

/* ------------------------------------------------------------- preview ---- */

const EXPORT: Array<[string, string]> = [
  [
    'Profile.csv',
    'First Name,Last Name,Headline,Summary,Geo Location,Websites\n' +
      'Anand,Sundaramoorthy,Full Stack Developer,"Engineer who ships, then measures.",Chennai,"[PORTFOLIO:https://anandsundaramoorthy.com]"\n',
  ],
  ['Email Addresses.csv', 'Email Address,Confirmed,Primary\nanand@example.com,Yes,Yes\n'],
  [
    'Positions.csv',
    'Company Name,Title,Description,Location,Started On,Finished On\n' +
      'DiffuseAI,Full Stack Developer,"• Built the billing rewrite, serving 200K requests a day\n' +
      '• Cut page load 40%",Chennai,Oct 2024,Oct 2025\n' +
      'DiffuseAi,Full Stack Developer,"• Built the billing rewrite, serving 200K requests a day",Chennai,Oct 2024,Oct 2025\n' +
      'Corizo,Flutter Developer,,Remote,Apr 2024,Jun 2024\n',
  ],
  ['Skills.csv', 'Name\nTypeScript\nPostgreSQL\nTypeScript\n'],
  [
    'Education.csv',
    'School Name,Start Date,End Date,Degree Name,Field Of Study\nAnna University,2022,2026,B.E.,Computer Science\n',
  ],
  [
    'Certifications.csv',
    'Name,Url,Authority,Started On\nAWS Cloud Practitioner,https://aws.example,Amazon Web Services,Mar 2025\n',
  ],
  ['Languages.csv', 'Name,Proficiency\nTamil,Native or bilingual proficiency\nEnglish,Full professional proficiency\n'],
  ['Honors.csv', 'Title,Description,Issued On\nHackathon winner,First of 60 teams,Aug 2025\n'],
  ['Volunteering.csv', 'Company Name,Role,Cause,Started On,Description\nGDSC,Mentor,Education,Jan 2025,Ran weekly sessions\n'],
  ['Projects.csv', 'Title,Description,Url,Started On\nResumer AI,Tailored ATS resumes,https://resumeraiapp.netlify.app,Feb 2026\n'],
  ['Publications.csv', 'Name,Published On,Description,Publisher,Url\nOn Retrieval,2025-08-01,A paper,IEEE,https://doi.example\n'],
];

function previewOfSampleExport() {
  const files = new Map<string, string>();
  for (const entry of readZip(makeZip(EXPORT))) {
    files.set(entry.name, entry.bytes.toString('utf8'));
  }
  return buildLinkedInPreview(files);
}

suite('linkedin preview', () => {
  const preview = previewOfSampleExport();
  const typed = (t: string) => preview.records.filter((r) => r.type === t);

  test('contact comes across, with the website label stripped', () => {
    assert(preview.contact?.fullName === 'Anand Sundaramoorthy', 'name joined');
    assert(preview.contact?.email === 'anand@example.com', 'email from its own file');
    assert(
      preview.contact?.portfolioUrl === 'https://anandsundaramoorthy.com',
      `the "[PORTFOLIO:...]" wrapper is a LinkedIn artefact, got ${preview.contact?.portfolioUrl}`,
    );
  });

  test('the About section becomes the summary, verbatim', () => {
    const summary = typed('summary');
    assert(summary.length === 1, `one summary, got ${summary.length}`);
    assert(
      summary[0].record.text === 'Engineer who ships, then measures.',
      `word for word, got ${JSON.stringify(summary[0].record.text)}`,
    );
  });

  test('two rows for one job become one role', () => {
    const diffuse = preview.roles.filter((r) => /diffuse/i.test(r.company));
    assert(diffuse.length === 1, `expected 1 DiffuseAI role, got ${diffuse.length}`);
  });

  test('job descriptions become bullets — the evidence a repo cannot provide', () => {
    const diffuse = preview.roles.find((r) => /diffuse/i.test(r.company))!;
    assert(diffuse.bullets.length === 2, `expected 2 bullets, got ${diffuse.bullets.length}`);
    const texts = diffuse.bullets.map((b) => String(b.record.text));
    assert(
      texts.includes('Built the billing rewrite, serving 200K requests a day'),
      `the comma inside the description did not split the row: ${JSON.stringify(texts)}`,
    );
    assert(texts.includes('Cut page load 40%'), 'and the second line survived the newline inside the quotes');
  });

  test('a repeated description does not become a repeated bullet', () => {
    const diffuse = preview.roles.find((r) => /diffuse/i.test(r.company))!;
    const texts = diffuse.bullets.map((b) => String(b.record.text));
    assert(new Set(texts).size === texts.length, 'the duplicated position row added nothing');
  });

  test('a position with no description still becomes a role', () => {
    const corizo = preview.roles.find((r) => r.company === 'Corizo');
    assert(corizo !== undefined, 'the job is not dropped for having no text');
    assert(corizo!.bullets.length === 0, 'and no accomplishment is invented for it');
    assert(
      preview.notes.some((n) => n.includes('no description')),
      `the gap is stated rather than left silent: ${JSON.stringify(preview.notes)}`,
    );
  });

  test('dates are normalised to one format', () => {
    const corizo = preview.roles.find((r) => r.company === 'Corizo')!;
    assert(corizo.startDate === '2024-04', `got ${corizo.startDate}`);
    assert(corizo.endDate === '2024-06', `got ${corizo.endDate}`);
  });

  test('every other section is carried across', () => {
    assert(typed('skill').length === 2, `duplicate skill collapsed, got ${typed('skill').length}`);
    assert(typed('education').length === 1, 'education');
    assert(typed('certification').length === 1, 'certification');
    assert(typed('language').length === 2, 'languages');
    assert(typed('award').length === 1, 'honors become awards');
    assert(typed('volunteering').length === 1, 'volunteering');
    assert(typed('project').length === 1, 'projects');
    assert(typed('publication').length === 1, 'publications');
  });

  test('proficiency wording is mapped to what the renderer knows', () => {
    const tamil = typed('language').find((r) => r.record.name === 'Tamil')!;
    assert(tamil.record.proficiency === 'native', `got ${tamil.record.proficiency}`);
    const english = typed('language').find((r) => r.record.name === 'English')!;
    assert(english.record.proficiency === 'fluent', `got ${english.record.proficiency}`);
  });

  test('everything is stamped as coming from LinkedIn', () => {
    assert(
      preview.records.every((r) => r.record.source === 'linkedin'),
      'provenance is what lets a sync leave these alone',
    );
  });

  test('every candidate carries a label a person can read', () => {
    for (const r of preview.records) {
      assert(r.label.trim().length > 0 && !r.label.startsWith('{'), `${r.type} labelled "${r.label}"`);
    }
  });

  test('an archive with none of the expected files says so', () => {
    const empty = buildLinkedInPreview(new Map([['Ad_Targeting.csv', 'a\n1\n']]));
    assert(empty.totalCount === 0, 'nothing proposed');
    assert(
      empty.notes.some((n) => n.includes('No recognised LinkedIn export files')),
      `the reason is given: ${JSON.stringify(empty.notes)}`,
    );
  });
});
