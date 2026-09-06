/**
 * Resumer AI logo.
 *
 * Concept: a document whose bottom line lifts off into a rising check — "resume,
 * verified, going up." Drawn as geometry rather than a font so it stays crisp at 16px
 * favicon size, and inline SVG so it is real markup a crawler can read (with a <title>
 * for both accessibility and SEO) rather than an opaque image request.
 *
 * Teal is the brand; the check is the gold accent, used here and almost nowhere else so
 * it keeps meaning "this passed."
 */

import * as React from 'react';

export function LogoMark({
  size = 32,
  className,
  title = 'Resumer AI',
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <rect width="32" height="32" rx="8" fill="url(#resumer-teal)" />
      {/* document sheet */}
      <path
        d="M9 8.5A1.5 1.5 0 0 1 10.5 7h7.3a1.5 1.5 0 0 1 1.06.44l3.2 3.2A1.5 1.5 0 0 1 22.5 11.7V23.5A1.5 1.5 0 0 1 21 25H10.5A1.5 1.5 0 0 1 9 23.5v-15Z"
        fill="#FFFFFF"
        fillOpacity="0.96"
      />
      {/* folded corner */}
      <path d="M18 7.2v3.3a1 1 0 0 0 1 1h3.3L18 7.2Z" fill="#B9DCDE" />
      {/* text lines */}
      <rect x="11.8" y="14.4" width="7.6" height="1.5" rx="0.75" fill="#0E7C86" fillOpacity="0.45" />
      <rect x="11.8" y="17.4" width="5.2" height="1.5" rx="0.75" fill="#0E7C86" fillOpacity="0.45" />
      {/* the third line lifts into a check */}
      <path
        d="M11.9 21.4h2.2l2.5 2.6 5.1-6.1"
        stroke="#C9922F"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <defs>
        <linearGradient id="resumer-teal" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#12909B" />
          <stop offset="1" stopColor="#0A5F67" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Logo({
  size = 30,
  showWordmark = true,
  className = '',
}: {
  size?: number;
  showWordmark?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      {showWordmark ? (
        <span className="font-display text-[1.15rem] leading-none text-ink">
          Resumer <span className="text-brand-dark">AI</span>
        </span>
      ) : null}
    </span>
  );
}
