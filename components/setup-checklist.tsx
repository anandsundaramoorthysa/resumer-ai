import { Logo } from './logo';

/**
 * First-boot state. A fresh clone has no database, no GitHub OAuth app, and possibly no
 * AI keys — so rather than crashing or showing an empty shell, the app says exactly what
 * is missing and what to do about it.
 */
export function SetupChecklist({
  database,
  auth,
  providers,
}: {
  database: boolean;
  auth: boolean;
  providers: string[];
}) {
  const items = [
    {
      done: database,
      title: 'Database connection',
      env: 'DATABASE_URL',
      how: 'Any Postgres works — a free Neon project (neon.tech) is the quickest. Then run `npm run db:push` to create the tables.',
    },
    {
      done: auth,
      title: 'GitHub sign-in',
      env: 'AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, AUTH_SECRET',
      how: 'Create an OAuth App at github.com/settings/developers with callback URL http://localhost:3000/api/auth/callback/github. Generate AUTH_SECRET with `npx auth secret`.',
    },
    {
      done: providers.length > 0,
      title: 'At least one AI provider',
      env: 'GOOGLE_GENERATIVE_AI_API_KEY, GROQ_API_KEY, DEEPINFRA_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY',
      how:
        providers.length > 0
          ? `Configured: ${providers.join(', ')}. They are tried in that order, falling back on failure.`
          : 'Any one of these is enough to start; more just means more fallbacks.',
    },
  ];

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8 text-center">
        <Logo size={44} showWordmark={false} className="mb-4" />
        <h1 className="font-display text-3xl">Almost ready</h1>
        <p className="mt-2 text-sm text-muted">
          Add the missing values to <code className="font-mono">.env</code> and reload.
          Nothing else is needed to start drafting.
        </p>
      </div>

      <ol className="space-y-3">
        {items.map((item) => (
          <li
            key={item.title}
            className="rounded-xl border border-line bg-surface p-4"
          >
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-semibold ${
                  item.done
                    ? 'bg-success-tint text-success'
                    : 'bg-warning-tint text-warning'
                }`}
              >
                {item.done ? '✓' : '!'}
              </span>
              <div className="min-w-0">
                <div className="font-semibold">{item.title}</div>
                <div className="mt-1 font-mono text-xs break-words text-muted">
                  {item.env}
                </div>
                {!item.done && (
                  <p className="mt-2 text-sm text-muted">{item.how}</p>
                )}
                {item.done && item.title.includes('AI') && (
                  <p className="mt-2 text-sm text-muted">{item.how}</p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-6 text-center text-xs text-muted">
        Full setup notes are in <code className="font-mono">README.md</code>.
      </p>
    </div>
  );
}
