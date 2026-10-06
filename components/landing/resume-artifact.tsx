/**
 * Static illustration of the product's promise: a resume page where every claim has a
 * source and an invented one is struck out. Decorative, so aria-hidden; the caption below
 * it (sr-only) says the same in one line.
 */
export function ResumeArtifact() {
  return (
    <figure className="mx-auto w-full max-w-md">
      <div
        aria-hidden="true"
        className="sheet relative rotate-[0.4deg] overflow-hidden p-5 font-display sm:p-7"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xl font-semibold tracking-tight sm:text-2xl">Priya Raman</p>
            <p className="text-sm text-muted">Backend engineer · Chennai</p>
          </div>
          <span className="stamp mt-1 shrink-0 text-success">
            <span className="text-xs">VERIFIED</span>
            <span className="text-lg leading-tight">8.7</span>
          </span>
        </div>

        <div className="mt-5 border-t border-line pt-3">
          <p className="eyebrow">Experience</p>
          <ul className="mt-2 space-y-3 text-sm leading-relaxed sm:text-base">
            <li>
              Built an event pipeline in <mark className="hl">PostgreSQL</mark> and Node that
              cut report time from 40 to 6 minutes.
              <span className="ml-1 inline-block border border-rule px-1.5 font-mono text-xs text-muted">
                [src: README §2]
              </span>
            </li>
            <li>
              Shipped a <mark className="hl">TypeScript</mark> SDK used by three internal teams.
            </li>
            <li>
              <s className="text-muted decoration-brand decoration-2">
                Led a 40-person org through an IPO.
              </s>
              <span className="mt-1 block font-sans text-xs font-semibold text-brand">
                ← No source, removed.
              </span>
            </li>
          </ul>
        </div>
      </div>
      <figcaption className="sr-only">
        Sample resume: keywords matched to a job are highlighted, and one invented claim is
        struck out with the note &ldquo;No source, removed.&rdquo;
      </figcaption>
    </figure>
  );
}
