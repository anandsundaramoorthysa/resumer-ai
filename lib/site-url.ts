/**
 * Resolves the app's public base URL.
 *
 * Deploying shouldn't require hand-editing an env var, and the deployment URL isn't
 * knowable until the first deploy anyway — so the host is detected from the platform,
 * with an explicit override available when you have a custom domain.
 *
 * Order of precedence:
 *   1. NEXT_PUBLIC_SITE_URL          — explicit; set this once you have a real domain
 *   2. VERCEL_PROJECT_PRODUCTION_URL — Vercel's stable production domain
 *   3. VERCEL_URL                    — Vercel's per-deployment URL (preview builds)
 *   4. URL / DEPLOY_PRIME_URL        — Netlify equivalents
 *   5. http://localhost:3000         — local development
 */

function withProtocol(host: string): string {
  if (/^https?:\/\//i.test(host)) return host.replace(/\/$/, '');
  return `https://${host.replace(/\/$/, '')}`;
}

export function getSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return withProtocol(explicit);

  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProd) return withProtocol(vercelProd);

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return withProtocol(vercel);

  // Netlify: URL is the canonical site, DEPLOY_PRIME_URL is the branch/preview URL.
  const netlify = process.env.URL?.trim() || process.env.DEPLOY_PRIME_URL?.trim();
  if (netlify) return withProtocol(netlify);

  return 'http://localhost:3000';
}

/** True when running on a real deployment rather than a local dev server. */
export function isDeployed(): boolean {
  return !getSiteUrl().startsWith('http://localhost');
}
