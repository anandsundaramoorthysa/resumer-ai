import { signIn } from '@/auth';
import { Logo } from '@/components/logo';

export const metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <main className="grid min-h-screen place-items-center px-5">
      <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-8 text-center">
        <Logo size={40} showWordmark={false} className="mb-5" />
        <h1 className="font-display text-2xl">Sign in to Resumer AI</h1>
        <p className="mt-2 text-sm text-muted">
          GitHub sign-in also grants the repo access used to keep your profile in sync,
          so there is no second credential to set up.
        </p>

        <form
          action={async () => {
            'use server';
            await signIn('github', { redirectTo: '/' });
          }}
        >
          <button
            type="submit"
            className="mt-6 w-full rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-white hover:bg-brand-dark"
          >
            Continue with GitHub
          </button>
        </form>

        <p className="mt-4 text-xs text-muted">
          Only read access is ever used — this app never writes to your repositories.
        </p>
      </div>
    </main>
  );
}
