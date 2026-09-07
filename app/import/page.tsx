import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AppHeader } from '@/components/app-header';
import { Importer } from './importer';

export const metadata = { title: 'Import an existing resume' };
export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/sign-in');

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/import" width="3xl" />

      <main className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-display text-3xl">Import an existing resume</h1>
        <p className="mt-2 text-sm text-muted">
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
