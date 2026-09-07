import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * These are loaded from node_modules at runtime rather than bundled.
   *
   * pdf-parse/pdfjs-dist resolve a worker file by path at runtime, which a bundler
   * rewrites out from under them; @react-pdf and docx are heavy Node-only renderers
   * with their own asset/font resolution. Keeping all four external is what makes the
   * round-trip self-test (REQ-6.6) work in a built app rather than only in dev.
   *
   * nodemailer is deliberately NOT here, and the reason is worth recording. It was,
   * as a precaution against its dynamic requires — and that precaution broke every
   * dynamic route in production. Turbopack rewrites an external package to a hashed
   * specifier, and Netlify's Lambda cannot resolve it:
   *
   *   Failed to load external module nodemailer-9c35dd349a8aaa9f:
   *   Cannot find package 'nodemailer-9c35dd349a8aaa9f'
   *
   * Every page that reaches lib/auth/mail.ts returned 500 — /sign-in, /api/health, the
   * lot — while the same build served perfectly under  locally, because
   * locally the real package is one directory away. It is bundled now, which is what a
   * pure-JS package should be.
   */
  serverExternalPackages: [
    'pdf-parse',
    'pdfjs-dist',
    '@react-pdf/renderer',
    'docx',
    'mammoth',
  ],

  /**
   * Security headers.
   *
   * `frame-ancestors`/`X-Frame-Options` is the one that closes a real hole: Next's
   * Server Actions carry an Origin check, which blocks a cross-origin action POST — but
   * a page framed by an attacker and clicked through by the victim is same-origin by
   * construction, so that check never fires. Without this, the delete buttons on
   * /profile are clickjackable.
   *
   * `Referrer-Policy` matters because verification and reset tokens travel in the query
   * string, and this app loads stylesheets from two font CDNs. On the default policy the
   * full reset URL can reach those third parties in the Referer header.
   *
   * The CSP allows inline styles and scripts because app/layout.tsx emits a JSON-LD
   * block and Tailwind injects styles; tightening that needs a nonce and is a separate
   * change. `object-src 'none'` and `base-uri 'self'` cost nothing and close two of the
   * cheapest injection escalations.
   */
  async headers() {
    const csp = [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
      "img-src 'self' data: https:",
      // React's development build uses eval() to reconstruct stack traces across the
      // server/client boundary, and without it the dev error overlay degrades to a
      // message about the CSP rather than the actual error. Production React never
      // calls eval, so this is not relaxed where it would matter.
      process.env.NODE_ENV === 'production'
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com",
      // The stylesheet and the font files come from DIFFERENT hosts. Fontshare serves
      // CSS from api.fontshare.com and the woff2 files from cdn.fontshare.com, so
      // allowing only the first let the stylesheet load and silently blocked every font
      // in it — the page rendered fine in a system fallback and nothing failed loudly.
      // Caught by loading the built app in a real browser and reading the console.
      "font-src 'self' data: https://fonts.gstatic.com https://api.fontshare.com https://cdn.fontshare.com",
      "connect-src 'self'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
      {
        // The two pages that carry a single-use credential in the URL send no referrer
        // at all, so the token cannot reach a font CDN or any other third party.
        source: '/:path(reset-password|verify-email)',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
    ];
  },
};

export default nextConfig;
