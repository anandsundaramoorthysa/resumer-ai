export default function Loading() {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8 sm:px-5">
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading your resume…</span>
        <p className="eyebrow">Review</p>
        <div className="mt-2 h-8 w-64 max-w-full bg-line motion-safe:animate-pulse" />
        <div className="sheet mx-auto mt-8 max-w-4xl space-y-3 p-4 sm:p-7" aria-hidden>
          {[70, 100, 90, 100, 60, 95, 80].map((w, i) => (
            <div key={i} className="h-4 bg-line motion-safe:animate-pulse" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    </main>
  );
}
