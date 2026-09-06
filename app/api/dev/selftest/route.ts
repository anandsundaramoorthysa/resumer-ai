/**
 * Dev-only render verification.
 *
 * Renders a fixture resume to PDF and DOCX inside the real Next runtime and parses both
 * back to text, so the round-trip self-test (REQ-6.6) is exercised where it actually
 * matters. `@react-pdf` ships ESM-only export conditions that standalone CJS runners
 * can't resolve, so this route — not a script — is the honest place to check the PDF.
 *
 * 404s in production.
 */

import { renderPresentationPdf, renderResumePdf } from '@/lib/render/pdf';
import { renderResumeDocx } from '@/lib/render/docx';
import { selfTest } from '@/lib/render/selftest';
import { resumeFileName } from '@/lib/render/filename';
import { scoreFormatting } from '@/lib/quality/formatting';
import type { ResumeDocument } from '@/lib/types';

export const runtime = 'nodejs';

const FIXTURE: ResumeDocument = {
  id: 'fixture',
  userId: 'fixture',
  contact: {
    fullName: 'Anand Sundaramoorthy',
    email: 'hello@anandsundaramoorthy.com',
    phone: '+91 90000 00000',
    location: 'Chennai, India',
    portfolioUrl: 'anandsundaramoorthy.com',
    githubUrl: 'github.com/anandsundaramoorthy',
  },
  sections: [
    {
      key: 'skills',
      heading: 'Skills',
      items: [
        {
          text: 'Technical SEO, Google Analytics, Next.js, TypeScript, PostgreSQL, Node.js',
          sourceRecordId: null,
        },
      ],
    },
    {
      key: 'experience',
      heading: 'Experience',
      items: [],
      groups: [
        {
          title: 'Full Stack Developer',
          subtitle: 'Freelance',
          dateRange: 'Jan 2022 – Present',
          items: [
            {
              text: 'Optimized PostgreSQL queries serving 200K daily requests, cutting p95 latency 40%.',
              sourceRecordId: 'b1',
            },
            {
              text: 'Ran technical SEO audits that lifted organic traffic 32% across 4 client sites.',
              sourceRecordId: 'b2',
            },
          ],
        },
      ],
    },
    {
      key: 'education',
      heading: 'Education',
      items: [{ text: 'B.E. Computer Science · Anna University · 2018 – 2022', sourceRecordId: 'e1' }],
    },
  ],
  jobRequirement: null,
  renderMode: 'ats-strict',
  recordHashSnapshot: [],
  createdAt: new Date(),
};

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return new Response('Not found', { status: 404 });
  }

  const started = Date.now();
  const [pdf, docx, presentation] = await Promise.all([
    renderResumePdf(FIXTURE),
    renderResumeDocx(FIXTURE),
    renderPresentationPdf(FIXTURE),
  ]);

  const [pdfTest, docxTest, presentationTest] = await Promise.all([
    selfTest(pdf, 'pdf', FIXTURE),
    selfTest(docx, 'docx', FIXTURE),
    // The presentation variant is not for a parser (REQ-6.2), but it is still checked:
    // the icons are vector geometry, so every contact value must survive as text. If
    // this ever fails, the icons stopped being decoration and started replacing content.
    selfTest(presentation, 'pdf', FIXTURE),
  ]);

  const formatting = scoreFormatting(FIXTURE);

  let docxRefusedPresentation = false;
  try {
    await renderResumeDocx({ ...FIXTURE, renderMode: 'presentation' });
  } catch {
    docxRefusedPresentation = true;
  }

  return Response.json({
    ok:
      pdfTest.passed &&
      docxTest.passed &&
      presentationTest.passed &&
      docxRefusedPresentation &&
      formatting.violations.length === 0,
    tookMs: Date.now() - started,
    formatting: {
      score: formatting.score,
      violations: formatting.violations,
    },
    pdf: {
      bytes: pdf.length,
      passed: pdfTest.passed,
      extractedChars: pdfTest.extractedChars,
      issues: pdfTest.issues,
      fileName: resumeFileName(FIXTURE, 'pdf'),
      textPreview: pdfTest.extractedText.replace(/\s+/g, ' ').slice(0, 320),
    },
    docx: {
      bytes: docx.length,
      passed: docxTest.passed,
      extractedChars: docxTest.extractedChars,
      issues: docxTest.issues,
      fileName: resumeFileName(FIXTURE, 'docx'),
      textPreview: docxTest.extractedText.replace(/\s+/g, ' ').slice(0, 320),
    },
    presentationPdf: {
      bytes: presentation.length,
      passed: presentationTest.passed,
      extractedChars: presentationTest.extractedChars,
      issues: presentationTest.issues,
      docxRefused: docxRefusedPresentation,
      textPreview: presentationTest.extractedText.replace(/\s+/g, ' ').slice(0, 320),
    },
  });
}
