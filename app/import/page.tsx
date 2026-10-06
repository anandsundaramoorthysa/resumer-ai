import { requireApprovedUser } from '@/lib/server/approval';
import { AppHeader } from '@/components/app-header';
import { Importer } from './importer';

export const metadata = { title: 'Import an existing resume' };
export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requireApprovedUser();

  return (
    <div className="min-h-screen min-h-dvh">
      <AppHeader current="/import" width="6xl" />

      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-5 py-8 outline-none">
        <p className="eyebrow">§ Import</p>
        <h1 className="mt-1 font-display text-4xl tracking-tight">Import an existing resume</h1>
        {/* The shell around this page is now 1152px, and this sentence is 250 characters
            of it. Without the cap it sets as a single 180-character line, which is about
            two and a half times a comfortable measure and is read by skipping. The cards
            underneath are what the extra width is for. */}
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
