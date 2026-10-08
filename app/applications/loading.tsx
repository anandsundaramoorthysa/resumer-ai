/** Route-level fallback: hairline-rule skeleton, no cards. Announced once, not per bar. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8" aria-busy="true">
      <p role="status" className="sr-only">
        Loading applications
      </p>
      <div aria-hidden="true">
        <div className="h-3 w-24 bg-line" />
        <div className="mt-4 h-9 w-2/3 max-w-md bg-line" />
        <div className="mt-10 border-t border-line">
          {[0,1,2,3,4].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b border-line py-5">
              <div className="h-3 w-10 bg-line" />
              <div className="h-4 flex-1 bg-line" style={{ maxWidth: `${80 - i * 10}%` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
