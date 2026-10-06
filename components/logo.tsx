/**
 * Resumer AI logo.
 *
 * A flat vermilion square with a white check, matching app/icon.svg. Inline SVG so it is
 * real markup with a <title>, and crisp at any size.
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
      <rect width="32" height="32" fill="#B8301A" />
      <path d="M8 17l5.5 5.5L24 10" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
    </svg>
  );
}

export function Logo({
  size = 30,
  showWordmark = true,
  className = '',
  wordmarkClassName = '',
}: {
  size?: number;
  showWordmark?: boolean;
  className?: string;
  /**
   * Extra classes on the wordmark alone.
   *
   * The header uses this to drop the name between `sm` and `md`, where the six navigation
   * links and the name cannot both fit on one row and the links are the more useful of the
   * two. The mark keeps the identity there; the name is back from `md` up.
   */
  wordmarkClassName?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      {showWordmark ? (
        <span className={`font-display text-lg leading-none text-ink ${wordmarkClassName}`}>
          Resumer <span className="text-brand">AI</span>
        </span>
      ) : null}
    </span>
  );
}
