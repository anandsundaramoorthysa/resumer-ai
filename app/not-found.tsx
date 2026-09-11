import Link from 'next/link';

export const metadata = { title: 'Not found' };

/** In the app's own look, rather than Next's default page — a link to a deleted resume lands here. */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg px-5 py-24">
      <h1 className="font-display text-3xl">Nothing here</h1>
      <p className="mt-3 text-sm text-muted">
        That page does not exist, or it belongs to something that has been removed.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand hover:bg-brand-dark"
      >
        Go to the dashboard
      </Link>
    </main>
  );
}
