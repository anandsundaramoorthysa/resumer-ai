import type { ReactNode } from 'react';

const BASE = 'inline-flex max-w-full items-center gap-1 border px-1.5 py-0.5 font-mono text-xs leading-snug';

/** Small label. `sample` is the highlighter-style SAMPLE DATA flag. */
export function Chip({ children, tone = 'plain', title }: { children: ReactNode; tone?: 'plain' | 'sample' | 'warn'; title?: string }) {
  const cls =
    tone === 'sample'
      ? 'border-transparent bg-hl text-ink font-semibold uppercase tracking-wider'
      : tone === 'warn'
        ? 'border-warning text-warning'
        : 'border-rule text-ink';
  return (
    <span className={`${BASE} ${cls}`} title={title}>
      {children}
    </span>
  );
}

export const SampleChip = () => <Chip tone="sample">Sample data</Chip>;
