/**
 * Waits until `floorMs` have passed since `startedAt` (a floor on total time, not an added
 * delay: slower work is not slowed further). Used so branches that differ in cost - an address
 * that has an account versus one that does not - answer in the same wall time.
 */
export async function holdUntilFloor(startedAt: number, floorMs: number, now: () => number = Date.now): Promise<void> {
  const left = floorMs - (now() - startedAt);
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
}
