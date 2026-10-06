/**
 * Public (no login, no database) Job Radar demo: only for /radar?demo=1, and only outside
 * production unless RADAR_PUBLIC_DEMO=1 opts a deployment in. Demo data is synthetic and
 * never touches the API, so exposing it needs no approval.
 */
export function canShowPublicDemo(
  env: { NODE_ENV?: string; RADAR_PUBLIC_DEMO?: string },
  demoParam: string | undefined,
): boolean {
  if (demoParam !== '1') return false;
  return env.NODE_ENV !== 'production' || env.RADAR_PUBLIC_DEMO === '1';
}
