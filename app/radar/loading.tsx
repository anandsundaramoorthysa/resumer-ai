/** Route-level fallback: hairline skeleton, announced once. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-8" aria-busy="true">
      <p role="status" className="sr-only">
        Loading Job Radar
      </p>
      <div aria-hidden="true">
        <div className="h-3 w-24 bg-line" />
        <div className="mt-4 h-9 w-3/4 max-w-xl bg-line" />
        <div className="mt-10 border-t border-line">
          {[0, 1, 2].map((i) => (
            <div key={i} className="border-b border-line py-5">
              <div className="h-4 bg-line" style={{ maxWidth: `${80 - i * 15}%` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
