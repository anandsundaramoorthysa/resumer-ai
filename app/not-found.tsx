import Link from 'next/link';

export const metadata = { title: 'Not found' };

/** In the app's own look, rather than Next's default page — a link to a deleted resume lands here. */
export default function NotFound() {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-lg px-5 py-24">
      <p className="eyebrow">§ 404</p>
      <h1 className="mt-2 font-display text-3xl tracking-tight">Nothing here</h1>
      <p className="mt-3 text-sm text-muted">
        That page does not exist, or it belongs to something that has been removed.
      </p>
      <Link href="/" className="btn btn-primary mt-6">
        Go to the dashboard
      </Link>
    </main>
  );
}
