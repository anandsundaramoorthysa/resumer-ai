/**
 * Rubber-stamp score. Meaning is in the words (VERIFIED / BELOW BAR / UNSCORED) and the
 * aria-label, never in colour alone. Uses the shared .stamp class.
 */

const SIZES = {
  sm: { box: 'px-2 py-0.5', num: 'text-base', word: 'text-xs' },
  md: { box: '', num: 'text-2xl', word: 'text-xs' },
  lg: { box: 'px-4 py-1.5', num: 'text-4xl', word: 'text-xs' },
} as const;

export function ScoreStamp({
  score,
  bar = 8.5,
  size = 'md',
  tilt = true,
  passed,
}: {
  score: number | null;
  bar?: number;
  size?: keyof typeof SIZES;
  /** Straighten it where a rotated box would crowd its neighbours. */
  tilt?: boolean;
  /** Overrides score >= bar when a pass needs more than the number (e.g. a keyword gate). */
  passed?: boolean;
}) {
  const s = SIZES[size];
  const scored = typeof score === 'number' && Number.isFinite(score);
  const pass = scored && (passed ?? score >= bar);
  const word = !scored ? 'Unscored' : pass ? 'Verified' : 'Below bar';
  const tone = !scored ? 'text-muted' : pass ? 'text-success' : 'text-warning';
  const label = scored
    ? `Score ${score.toFixed(1)} of 10, ${pass ? 'meets' : 'below'} the ${bar} bar`
    : 'Not scored yet';

  return (
    <span
      role="img"
      aria-label={label}
      className={`stamp ${tone} ${s.box}`}
      style={tilt ? undefined : { transform: 'none' }}
    >
      <span aria-hidden className={`${s.num} tabular-nums leading-none`}>
        {scored ? score.toFixed(1) : '–'}
      </span>
      <span aria-hidden className={s.word}>
        {word}
      </span>
    </span>
  );
}
