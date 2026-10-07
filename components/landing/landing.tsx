import Link from 'next/link';
import { ResumeArtifact } from './resume-artifact';
import { LegalFooter } from '@/components/legal-footer';

const STEPS = [
  ['§ 1', 'Import', 'Upload a resume or connect GitHub. Facts are read out and shown to you first.'],
  ['§ 2', 'Match', 'Paste a job. Your profile is checked against what it actually asks for.'],
  ['§ 3', 'Verify', 'Every line traces to a source fact. Anything unsourced is removed.'],
  ['§ 4', 'Export', 'Download an ATS-ready PDF, or DOCX if an employer insists.'],
  [
    '§ 5',
    'Discover',
    'Job Radar finds live openings through Google Jobs (SerpApi), ranks them against your real profile, and shows its sources.',
  ],
] as const;

export function Landing() {
  return (
    <>
      <section className="grid items-center gap-10 py-6 lg:grid-cols-2 lg:gap-14 lg:py-12">
        <div className="rise">
          <p className="eyebrow">Resumer AI</p>
          <h1 className="mt-3 font-display text-4xl tracking-tight sm:text-5xl">
            One profile. Every role. No invented facts.
          </h1>
          <p className="mt-5 max-w-prose text-base text-muted">
            Build one profile from your real resume or GitHub, then draft a tailored,
            ATS-ready resume for any job. Each line is traced to a source, and a claim with
            no source is left out.
          </p>
          <p className="mt-4 max-w-prose border-l-[3px] border-brand pl-3 text-sm">
            <strong>Access is by owner approval.</strong> You can create an account, but the
            site owner approves each one by hand before it can be used.
          </p>
          <Link href="/sign-in" className="btn btn-primary mt-7">
            Sign in or create account
          </Link>
        </div>
        <div className="rise min-w-0" style={{ '--i': 2 } as React.CSSProperties}>
          <ResumeArtifact />
        </div>
      </section>

      <section aria-labelledby="how" className="mt-10 border-t border-line pt-6">
        <h2 id="how" className="sr-only">
          How it works
        </h2>
        <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map(([n, name, text]) => (
            <li key={n}>
              <p className="eyebrow">
                {n} <span className="text-ink">{name}</span>
              </p>
              <p className="mt-2 text-sm text-muted">{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="mt-10 border-t border-line py-6 text-center text-xs text-muted sm:text-left">
        <p className="mb-3 max-w-prose text-sm max-sm:mx-auto">
          It is a drafting tool, not a guarantee: scores are the model&apos;s estimate and you
          approve what goes on the page.
        </p>
        Resumer AI · Read-only access to your repositories · Access by invite or owner approval
        <LegalFooter className="mt-3" />
      </footer>
    </>
  );
}
