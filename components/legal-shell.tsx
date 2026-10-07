import Link from 'next/link';
import { ThemeCorner } from '@/components/theme-corner';
import { LegalFooter } from '@/components/legal-footer';

/**
 * Shared frame for the legal pages: skip-link target, one h1, readable measure, theme toggle.
 * No auth call anywhere, so the pages hold no per-user data.
 */
export function LegalShell({
  eyebrow,
  title,
  meta,
  children,
}: {
  eyebrow: string;
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <main id="main" tabIndex={-1} className="relative mx-auto max-w-3xl px-5 pb-10 pt-16 outline-none">
      <ThemeCorner />
      <Link href="/" className="inline-flex min-h-11 items-center text-sm text-muted underline hover:text-ink">
        ← Resumer AI
      </Link>
      <p className="eyebrow mt-4">{eyebrow}</p>
      <h1 className="mt-2 font-display text-4xl tracking-tight text-balance">{title}</h1>
      {meta ? <p className="mt-2 text-sm text-muted">{meta}</p> : null}
      <div className="legal-prose mt-8 text-sm leading-relaxed [&_h2]:mt-10 [&_h2]:border-t [&_h2]:border-line [&_h2]:pt-4 [&_h2]:font-display [&_h2]:text-xl [&_li]:mt-1.5 [&_p]:mt-3 [&_p]:max-w-prose [&_ul]:mt-3 [&_ul]:max-w-prose [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
      <LegalFooter className="mt-12 border-t border-line pt-4" />
    </main>
  );
}
