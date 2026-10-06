/** Route-level fallback: hairline-rule skeleton, no cards. Announced once, not per bar. */
export default function Loading() {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-10 sm:px-5" aria-busy="true">
      <p role="status" className="sr-only">
        Loading
      </p>
      <div aria-hidden="true">
        <div className="h-3 w-24 bg-line" />
        <div className="mt-4 h-9 w-2/3 max-w-md bg-line" />
        <div className="mt-10 border-t border-line">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b border-line py-5">
              <div className="h-3 w-10 bg-line" />
              <div className="h-4 flex-1 bg-line" style={{ maxWidth: `${70 - i * 10}%` }} />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
