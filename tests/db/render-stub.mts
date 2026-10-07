/**
 * Stands in for `@/lib/render/pdf` and `@/lib/render/docx` in the `db-*` suites: the real ones
 * pull in @react-pdf/renderer, which tsx cannot load (see tests/pdf-fonts.test.mts). The
 * export routes' own logic — authentication, ownership, format and headers — is what the
 * route tests are about; real rendering is covered by scripts/verify-pdf-*.mts.
 */
export async function renderResumePdf(): Promise<Buffer> {
  return Buffer.from('%PDF-stub-resume');
}
export async function renderPresentationPdf(): Promise<Buffer> {
  return Buffer.from('%PDF-stub-presentation');
}
export async function renderResumeDocx(): Promise<Buffer> {
  return Buffer.from('PK-stub-docx');
}
