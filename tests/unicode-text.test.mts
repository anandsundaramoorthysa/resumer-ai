/**
 * Text correctness beyond ASCII — the bugs the audit reproduced with Tamil, Hindi, CJK and
 * punctuation-adjacent keywords:
 *
 *   - keyword gate: "R", "Go", "C", "Net" matched inside "R&D", "go-to-market", "C++",
 *     "ASP.NET";
 *   - identity: every non-Latin company/title/skill normalised to "", so unrelated jobs
 *     merged and non-Latin skills vanished;
 *   - dates: "Dec 2024" and "Mar 2024" ranked as the same month;
 *   - file names: NFKD + strip-marks deleted Indic vowel signs;
 *   - tidy: stripping ZWJ/ZWNJ broke conjuncts and ZWJ emoji.
 */

import { assert, report, suite, test } from './harness.mjs';
import { containsPhrase, holdsKeyword, textHoldsKeyword } from '@/lib/quality/vocabulary';
import { normalizeForMatch, scoreKeywordCoverage } from '@/lib/quality/keywords';
import { dedupeRoles, normalizeCompany, roleIdentity, sameJob } from '@/lib/sync/roles';
import { dedupeSkillNames, normalizeSkill, skillIdentity } from '@/lib/skills/identity';
import { dateRank } from '@/lib/profile/ordering';
import { attachmentHeader, resumeFileName } from '@/lib/render/filename';
import { tidyText } from '@/lib/steward/tidy';
import type { ResumeDocument } from '@/lib/types';

const ZWJ = String.fromCharCode(0x200d);
const ZWNJ = String.fromCharCode(0x200c);
const ZWSP = String.fromCharCode(0x200b);

suite('keyword gate: short keywords need a real boundary', () => {
  test('R is not inside R&D, Go not inside go-to-market, C not inside C++ or C#, Net not inside ASP.NET', () => {
    assert.equal(containsPhrase('worked in r&d on new products', 'r'), false);
    assert.equal(containsPhrase('owned go-to-market strategy', 'go'), false);
    assert.equal(containsPhrase('wrote c++ and c# services', 'c'), false);
    assert.equal(containsPhrase('built asp.net apps', 'net'), false);
    assert.equal(containsPhrase('uses f# daily', 'f'), false);
  });

  test('and they still match when they really are the word', () => {
    assert.equal(containsPhrase('python, r, sql', 'r'), true);
    assert.equal(containsPhrase('statistics in r.', 'r'), true);
    assert.equal(containsPhrase('services in go, rust', 'go'), true);
    assert.equal(containsPhrase('drivers in c', 'c'), true);
    assert.equal(containsPhrase('net revenue growth', 'net'), true);
    assert.equal(containsPhrase('ai-powered search', 'ai'), true);
    assert.equal(containsPhrase('c++ and c', 'c'), true);
  });

  test('through the normaliser the gate really uses ("&" must survive it)', () => {
    assert.equal(textHoldsKeyword('Led R&D for the platform', 'R'), false);
    assert.equal(textHoldsKeyword('Go-to-market planning', 'Go'), false);
    assert.equal(textHoldsKeyword('Skills: Python, R, SQL', 'R'), true);
    assert.equal(holdsKeyword(['C++', 'C#'], 'C'), false);
    assert.equal(holdsKeyword(['C', 'C++'], 'C'), true);
  });

  test('scoreKeywordCoverage does not credit R from R&D', () => {
    const doc = {
      sections: [{ key: 'experience', heading: 'Experience', items: [{ text: 'Led R&D and go-to-market for ASP.NET products using C++' }] }],
      jobRequirement: { atsKeywords: ['R', 'Go', 'C', 'Net'] },
    } as unknown as ResumeDocument;
    const r = scoreKeywordCoverage(doc);
    assert.deepEqual(r.matched, [], `credited ${r.matched.join(', ')}`);
    assert.ok(normalizeForMatch('R&D').includes('&'));
  });
});

suite('identity survives non-Latin scripts', () => {
  test('Hindi and Tamil company and title names are not "::"', () => {
    const hi = roleIdentity('टाटा कंसल्टेंसी', 'सॉफ्टवेयर इंजीनियर');
    const ta = roleIdentity('இன்ஃபோசிஸ்', 'டெவலப்பர்');
    assert.notEqual(hi, '::');
    assert.notEqual(ta, '::');
    assert.notEqual(hi, ta);
  });

  test('dedupe keeps different non-Latin jobs apart, and merges the same one', () => {
    const kept = dedupeRoles([
      { title: 'इंजीनियर', company: 'टाटा', startDate: '2019-01', endDate: '2020-01' },
      { title: 'डेवलपर', company: 'इन्फोसिस', startDate: '2021-01', endDate: 'present' },
    ]);
    assert.equal(kept.length, 2);
    const merged = dedupeRoles([
      { title: 'இன்ஜினியர்', company: 'இன்ஃபோசிஸ்', startDate: '2019-01', endDate: '2020-01' },
      { title: 'இன்ஜினியர்', company: 'இன்ஃபோசிஸ்', startDate: '2019-01', endDate: '2020-01' },
    ]);
    assert.equal(merged.length, 1);
  });

  test('CJK names', () => {
    assert.notEqual(roleIdentity('北京科技', '工程师'), roleIdentity('上海科技', '工程师'));
    assert.notEqual(roleIdentity('北京科技', '工程师'), roleIdentity('北京科技', '经理'));
    assert.equal(roleIdentity('北京科技', '工程师'), roleIdentity('北京科技', '工程师'));
  });

  test('Indic vowel signs are marks, and they are kept', () => {
    assert.notEqual(normalizeCompany('कंपनी'), normalizeCompany('कपनी'), 'anusvara is part of the word');
    assert.notEqual(normalizeCompany('टाटा'), '');
  });

  test('a name that normalises to nothing has NO identity: only identical raw text collides', () => {
    assert.notEqual(roleIdentity('😀', 'Engineer'), roleIdentity('🚀', 'Engineer'));
    assert.equal(roleIdentity('😀', 'Engineer'), roleIdentity('😀', 'Engineer'));
    assert.notEqual(roleIdentity('!!!', '???'), roleIdentity('###', '***'));
    assert.ok(!roleIdentity('😀', 'Engineer').startsWith('::'));
  });

  test('non-Latin skills are not erased', () => {
    assert.deepEqual(dedupeSkillNames(['पायथन', 'जावा', 'தமிழ்']), ['पायथन', 'जावा', 'தமிழ்']);
    assert.equal(dedupeSkillNames(['पायथन', 'पायथन']).length, 1);
    assert.notEqual(skillIdentity('पायथन'), skillIdentity('जावा'));
    assert.equal(normalizeSkill('தமிழ்'), 'தமிழ்');
    assert.ok(skillIdentity('🔥').length > 0, 'a symbol-only skill is not silently dropped');
  });

  test('the ASCII behaviour is unchanged', () => {
    assert.equal(skillIdentity('ReactJS'), 'react');
    assert.equal(normalizeSkill('C++'), 'c++');
    assert.equal(normalizeCompany('Acme Pvt. Ltd.'), 'acme');
  });
});

suite('the same title at the same company is two jobs when the dates say so', () => {
  const intern = { title: 'Software Engineer Intern', company: 'Acme', startDate: '2022-06', endDate: '2022-08' };
  const fullTime = { title: 'Software Engineer', company: 'Acme', startDate: '2024-07', endDate: 'present' };

  test('an internship and a later full-time role are not merged', () => {
    assert.equal(dedupeRoles([intern, fullTime]).length, 2);
    assert.equal(sameJob(intern, fullTime), false);
  });

  test('overlapping tellings of one job still merge, and so does an undated twin', () => {
    assert.equal(dedupeRoles([intern, { ...intern, title: 'Software Engineer (Paid Intern)' }]).length, 1);
    assert.equal(dedupeRoles([intern, { ...intern, startDate: '', endDate: '' }]).length, 1);
    assert.equal(dedupeRoles([{ ...intern, endDate: '2022' }, { ...intern, startDate: '2022', endDate: '2022-08' }]).length, 1);
  });

  test('an intern role that turns straight into a full-time one is two jobs', () => {
    const converted = { title: 'Software Engineer', company: 'Acme', startDate: '2022-09', endDate: '2024-01' };
    assert.equal(dedupeRoles([intern, converted]).length, 2);
  });

  test('the start year is part of the key when a caller passes it', () => {
    assert.notEqual(roleIdentity('Acme', 'Engineer', '2022-06'), roleIdentity('Acme', 'Engineer', '2024-07'));
    assert.equal(roleIdentity('Acme', 'Engineer'), roleIdentity('Acme', 'Engineer'));
  });
});

suite('dates written in words order correctly', () => {
  test('Dec 2024 is later than Mar 2024', () => {
    assert.ok(dateRank('Dec 2024')! > dateRank('Mar 2024')!);
    assert.equal(dateRank('Dec 2024'), 202412);
    assert.equal(dateRank('September 2023'), 202309);
    assert.equal(dateRank('Sept 2023'), 202309);
  });
  test('numeric forms and the old forms are unchanged', () => {
    assert.equal(dateRank('06/2024'), 202406);
    assert.equal(dateRank('2024-06'), 202406);
    assert.equal(dateRank('2024'), 202406, 'a bare year is its middle month');
    assert.equal(dateRank('present'), Number.MAX_SAFE_INTEGER);
    assert.equal(dateRank('soon'), null);
  });
});

suite('file names keep the name in the candidate\'s script', () => {
  const doc = (name: string, extra: object = {}) => ({ contact: { fullName: name }, ...extra }) as unknown as ResumeDocument;

  test('Devanagari vowel signs and viramas survive', () => {
    assert.equal(resumeFileName(doc('आनंद शर्मा'), 'pdf'), 'आनंद_शर्मा_Resume.pdf');
  });
  test('Tamil and CJK names survive', () => {
    assert.equal(resumeFileName(doc('ஆனந்த் சுந்தரமூர்த்தி'), 'pdf'), 'ஆனந்த்_சுந்தரமூர்த்தி_Resume.pdf');
    assert.equal(resumeFileName(doc('李 小龍'), 'docx'), '李_小龍_Resume.docx');
  });
  test('unsafe characters become word breaks; emoji go', () => {
    assert.equal(resumeFileName(doc('Anand 😀 S/Kumar: "CEO"'), 'pdf'), 'Anand_S_Kumar_CEO_Resume.pdf');
    assert.ok(!/[\\/:*?"<>|]/.test(resumeFileName(doc('a/b\\c:d*e?f"g<h>i|j'), 'pdf')));
  });
  test('accents are NFC-composed, not stripped', () => {
    assert.equal(resumeFileName(doc('José Müller'), 'pdf'), 'José_Müller_Resume.pdf');
  });
  test('the name part is capped at 60 characters', () => {
    const long = resumeFileName(doc('A'.repeat(5000)), 'pdf');
    assert.ok(Array.from(long.replace('_Resume.pdf', '')).length <= 60, String(long.length));
  });
  test('the target part (company) is slugged the same way', () => {
    const d = doc('Anand', { jobRequirement: { company: 'टाटा कंसल्टेंसी', roleTitle: 'x' } });
    assert.equal(resumeFileName(d, 'pdf'), 'Anand_टाटा_कंसल्टेंसी.pdf');
  });
  test('the header has an ASCII fallback and an RFC 5987 UTF-8 name', () => {
    const name = resumeFileName(doc('आनंद शर्मा'), 'pdf');
    const header = attachmentHeader(name);
    new Response('x', { headers: { 'Content-Disposition': header } });
    assert.ok(header.includes('filename="Resume.pdf"'), header);
    assert.ok(header.includes(`filename*=UTF-8''${encodeURIComponent(name)}`), header);
    const quoted = attachmentHeader("O'Brien (CV)*.pdf");
    assert.ok(!/filename\*=[^;]*['()*][^;]*$/.test(quoted.replace("UTF-8''", '')), quoted);
  });
});

suite('tidy keeps joiners', () => {
  test('ZWJ in a Devanagari conjunct survives; zero-width space does not', () => {
    const conjunct = 'क्' + ZWJ + 'ष';
    assert.equal(tidyText(conjunct), conjunct);
    assert.equal(tidyText('a' + ZWSP + 'b'), 'ab');
  });
  test('ZWNJ (Malayalam/Persian) and ZWJ emoji sequences survive', () => {
    const word = 'ക' + ZWNJ + 'ഷ';
    assert.equal(tidyText(word), word);
    const family = '👨' + ZWJ + '👩' + ZWJ + '👧';
    assert.equal(tidyText(`Team ${family}`), `Team ${family}`);
  });
  test('BOM and word joiner are still removed', () => {
    assert.equal(tidyText(String.fromCharCode(0xfeff) + 'x' + String.fromCharCode(0x2060) + 'y'), 'xy');
  });
});

report('unicode-text');
