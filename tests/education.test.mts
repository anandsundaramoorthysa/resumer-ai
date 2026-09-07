/**
 * Education identity — every case below is a real row from the live profile, which held
 * one Master's three times and a language certificate filed as a degree.
 */

import {
  dedupeEducation,
  educationIdentity,
  looksLikeCertification,
  mergeEducation,
  normalizeCredential,
  normalizeInstitution,
  partitionEducation,
  type EducationLike,
} from '../lib/sync/education';
import { suite, test, assert, report } from './harness.mjs';

/** The four rows as they actually sit in `profile_record` today. */
const OBSERVED: EducationLike[] = [
  {
    credential: 'M.Sc.',
    institution: 'Loyola College (Autonomous), Chennai',
    field: 'Data Science',
    startDate: '2024-06',
  },
  {
    credential: 'MSc',
    institution: 'Loyola College',
    field: 'Data Science',
    startDate: '2027',
  },
  {
    credential: 'M.Sc. Data Science',
    institution: 'Loyola College (Autonomous), Chennai',
    field: 'Data Science',
    endDate: '2027',
  },
  {
    credential: 'Certification in Hindi Proficiency',
    institution: 'Dakshina Bharat Hindi Prachar Sabha',
    startDate: '2015-01-01',
  },
];

const same = (a: EducationLike, b: EducationLike) =>
  educationIdentity(a.institution, a.credential, a.field) ===
  educationIdentity(b.institution, b.credential, b.field);

suite('education identity', () => {
  test('a parenthetical and a city do not make a second college', () => {
    assert(
      normalizeInstitution('Loyola College (Autonomous), Chennai') ===
        normalizeInstitution('Loyola College'),
      'one college, written two ways',
    );
  });

  test('two different colleges never collapse', () => {
    assert(
      normalizeInstitution('Loyola College') !==
        normalizeInstitution("St. Joseph's College"),
      'distinct institutions',
    );
    assert(
      normalizeInstitution('Loyola College') !== normalizeInstitution('Loyola University'),
      'the institution-type word is part of the name, not noise',
    );
  });

  test('a campus named after the comma is kept', () => {
    assert(
      normalizeInstitution('University of California, Berkeley') !==
        normalizeInstitution('University of California, Los Angeles'),
      'here the comma tail is the campus, not a city',
    );
  });

  test('punctuation and spacing in a credential are noise', () => {
    assert(normalizeCredential('M.Sc.') === normalizeCredential('MSc'), 'one degree');
  });

  test('a credential repeating its own field reduces to the degree', () => {
    assert(
      normalizeCredential('M.Sc. Data Science', 'Data Science') ===
        normalizeCredential('M.Sc.', 'Data Science'),
      'the field is stated twice, not two degrees',
    );
  });

  test('different degrees stay different', () => {
    assert(normalizeCredential('M.Sc.') !== normalizeCredential('B.Sc.'), 'master vs bachelor');
    assert(normalizeCredential('M.Sc.') !== normalizeCredential('M.A.'), 'science vs arts');
    assert(
      !same(
        { credential: 'M.Sc.', institution: 'Loyola College', field: 'Data Science' },
        { credential: 'B.Sc.', institution: 'Loyola College', field: 'Data Science' },
      ),
      'two real degrees at one college are two records',
    );
  });

  test('two subjects at one level are not one degree', () => {
    assert(
      !same(
        { credential: 'M.Sc. Physics', institution: 'Loyola College', field: 'Physics' },
        { credential: 'M.Sc. Data Science', institution: 'Loyola College', field: 'Data Science' },
      ),
      'a second Master’s is a real thing to hold',
    );
  });

  test('merging keeps the fuller telling of each string', () => {
    const merged = mergeEducation(OBSERVED[0], OBSERVED[2]);
    assert(merged.credential === 'M.Sc. Data Science', 'the fuller credential wins');
    assert(
      merged.institution === 'Loyola College (Autonomous), Chennai',
      'the fuller institution wins',
    );
  });

  test('a start date of 2027 beside an end of 2027 is a graduation year', () => {
    const merged = mergeEducation(mergeEducation(OBSERVED[0], OBSERVED[1]), OBSERVED[2]);
    assert(merged.startDate === '2024-06', `start should be 2024-06, got ${merged.startDate}`);
    assert(merged.endDate === '2027', `end should be 2027, got ${merged.endDate}`);
  });

  test('a bare year is not preferred over a precise YYYY-MM', () => {
    const merged = mergeEducation(
      { credential: 'M.Sc.', institution: 'Loyola College', startDate: '2024' },
      { credential: 'M.Sc.', institution: 'Loyola College', startDate: '2024-06' },
    );
    assert(merged.startDate === '2024-06', `expected 2024-06, got ${merged.startDate}`);
  });

  test('a date stated once never becomes a range', () => {
    const merged = mergeEducation(
      { credential: 'M.Sc.', institution: 'Loyola College', startDate: '2024-06' },
      { credential: 'MSc', institution: 'Loyola College' },
    );
    assert(merged.startDate === '2024-06', 'the one real date survives');
    assert(merged.endDate === undefined, 'and no end date is invented');
  });

  test('the three M.Sc. rows collapse to exactly one', () => {
    const degrees = OBSERVED.filter((e) => !looksLikeCertification(e));
    const deduped = dedupeEducation(degrees);
    assert(deduped.length === 1, `expected 1 degree, got ${deduped.length}`);

    const [msc] = deduped;
    assert(msc.credential === 'M.Sc. Data Science', `credential: ${msc.credential}`);
    assert(
      msc.institution === 'Loyola College (Autonomous), Chennai',
      `institution: ${msc.institution}`,
    );
    assert(msc.startDate === '2024-06', `start: ${msc.startDate}`);
    assert(msc.endDate === '2027', `end: ${msc.endDate}`);
  });

  test('the Hindi row is a certification, not education', () => {
    const cert = looksLikeCertification(OBSERVED[3]);
    assert(cert !== null, 'a language certificate is not a degree');
    assert(cert!.name === 'Certification in Hindi Proficiency', `name: ${cert!.name}`);
    assert(cert!.issuer === 'Dakshina Bharat Hindi Prachar Sabha', `issuer: ${cert!.issuer}`);
  });

  test('a genuine degree is never demoted', () => {
    assert(looksLikeCertification(OBSERVED[0]) === null, 'M.Sc. stays education');
    assert(
      looksLikeCertification({
        credential: 'B.Sc. Computer Science',
        institution: "St. Joseph's College (Autonomous)",
        field: 'Computer Science',
      }) === null,
      'B.Sc. stays education',
    );
    assert(
      looksLikeCertification({
        credential: 'Post Graduate Diploma in Management',
        institution: 'Loyola Institute of Business Administration',
      }) === null,
      'a post-graduate diploma is a qualification, not a certificate',
    );
    assert(
      looksLikeCertification({
        credential: 'Diploma in Computer Applications',
        institution: 'Loyola College (Autonomous), Chennai',
      }) === null,
      'a diploma awarded by a college is real education',
    );
  });

  test('a certificate from a non-academic issuer is reclassified', () => {
    assert(
      looksLikeCertification({
        credential: 'Diploma in Digital Marketing',
        institution: 'Great Learning',
      }) !== null,
      'a training provider issues certificates, not degrees',
    );
  });

  test('the live four rows become one degree and one certification', () => {
    const { education, certifications } = partitionEducation(OBSERVED);
    assert(education.length === 1, `expected 1 education row, got ${education.length}`);
    assert(
      certifications.length === 1,
      `expected 1 certification, got ${certifications.length}`,
    );
    assert(
      certifications[0].issuedDate === '2015-01-01',
      'the date the source gave is kept, not discarded',
    );
  });
});

report('education identity');
