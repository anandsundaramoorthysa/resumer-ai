/**
 * A two-column DOCX (the layout most Indian resume templates use): headings and jobs sit in
 * table cells separated by <w:br/>. They must come out on their own lines.
 */
import JSZip from 'jszip';
import { suiteAsync, testAsync, assert } from './harness.mjs';
import { extractUploadText } from '../lib/import/text';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const run = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;
const cell = (...paras: string[]) => `<w:tc>${paras.join('')}</w:tc>`;

async function makeDocx(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

await suiteAsync('DOCX table layout keeps its line breaks', async () => {
  await testAsync('headings are not glued to the content that follows them', async () => {
    const table =
      '<w:tbl><w:tr>' +
      cell(
        // Heading, then a <w:br/> inside the same paragraph, then the content.
        para(run('SKILLS'), '<w:r><w:br/></w:r>', run('पायथन, Python, SQL')),
        para(run('EXPERIENCE'), '<w:r><w:br/></w:r>', run('Software Engineer, Zoho')),
      ) +
      cell(para(run('LANGUAGES')), para(run('தமிழ், English'))) +
      '</w:tr></w:tbl>';
    const { text } = await extractUploadText(await makeDocx(table), 'docx');
    const lines = text.split('\n');
    assert(lines.includes('SKILLS'), JSON.stringify(text));
    assert(lines.includes('पायथन, Python, SQL'), JSON.stringify(text));
    assert(lines.includes('EXPERIENCE'), JSON.stringify(text));
    assert(lines.includes('Software Engineer, Zoho'), JSON.stringify(text));
    assert(lines.includes('LANGUAGES') && lines.includes('தமிழ், English'), JSON.stringify(text));
    assert(!/SKILLSपायथन|EXPERIENCESoftware/.test(text));
  });

  await testAsync('entities and ordinary paragraphs survive', async () => {
    const { text } = await extractUploadText(await makeDocx(para(run('R&amp;D &lt;lead&gt;')) + para(run('Next line'))), 'docx');
    assert.equal(text, 'R&D <lead>\nNext line');
  });
});
