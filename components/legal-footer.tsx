import Link from 'next/link';
import { APP_NAME, LEGAL_LINKS, OPERATOR } from '@/lib/legal/config';

/** Privacy · Terms · Contact · Accessibility, plus the copyright line. A server component with no state. */
export function LegalFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`text-xs text-muted ${className}`}>
      <nav aria-label="Legal" className="flex flex-wrap items-center justify-center gap-x-1 sm:justify-start">
        {LEGAL_LINKS.map((l, i) => (
          <span key={l.href} className="inline-flex items-center">
            {i > 0 ? <span aria-hidden="true" className="px-1">·</span> : null}
            <Link href={l.href} className="inline-flex min-h-11 items-center px-1 underline hover:text-ink">
              {l.label}
            </Link>
          </span>
        ))}
      </nav>
      <p className="mt-1 text-center sm:text-left">
        © {new Date().getFullYear()} {APP_NAME} · {OPERATOR.name}
      </p>
    </footer>
  );
}
