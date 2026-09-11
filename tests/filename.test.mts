/**
 * Download names — lib/render/filename.ts. A header value that is not bytes throws inside
 * `new Response`, which turned every export for a non-Latin name into a 500.
 */

import { suite, test, assert } from './harness.mjs';
import { attachmentHeader } from '../lib/render/filename';

suite('the download header', () => {
  test('a name in any script survives, and Response accepts the header', () => {
    const header = attachmentHeader('Jose_Muller_北京_Tech.pdf');
    new Response('x', { headers: { 'Content-Disposition': header } });
    assert(header.includes(`filename*=UTF-8''${encodeURIComponent('Jose_Muller_北京_Tech.pdf')}`), 'real name encoded');
    assert(header.includes('filename="Jose_Muller_Tech.pdf"'), `ASCII fallback, got ${header}`);
  });

  test('a name with no Latin letters at all still has a fallback', () => {
    const header = attachmentHeader('ஆனந்த்_சுந்தரமூர்த்தி.docx');
    new Response('x', { headers: { 'Content-Disposition': header } });
    assert(header.startsWith('attachment; filename="Resume.docx"'), header);
  });

  test('a plain name is unchanged', () => {
    assert(attachmentHeader('Anand_S_Acme.pdf').startsWith('attachment; filename="Anand_S_Acme.pdf"'), 'unchanged');
  });
});
