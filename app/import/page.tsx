import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { Logo } from '@/components/logo';
import { Importer } from './importer';

export const metadata = { title: 'Import an existing resume' };
export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-3.5">
          <Link href="/" className="inline-flex min-h-11 items-center">
            <Logo />
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/profile" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
              Profile
            </Link>
            <Link href="/" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
              Dashboard
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-display text-3xl">Import an existing resume</h1>
        <p className="mt-2 max-w-prose text-sm text-muted">
          The fastest way to fill an empty profile. Your resume is read, split into the
          individual facts behind it, and shown to you for approval — because every line
          Resumer AI generates is checked against these records, so what lands here
          decides what it is allowed to say about you.
        </p>

        <div className="mt-7">
          <Importer />
        </div>
      </main>
    </div>
  );
}
