import assert from 'node:assert/strict';
import { canShowPublicDemo } from '../app/radar/demo-gate';

const cases: Array<[string, string | undefined, string | undefined, boolean]> = [
  // NODE_ENV, RADAR_PUBLIC_DEMO, demo param, expected
  ['production', undefined, '1', false],
  ['production', '0', '1', false],
  ['production', '1', '1', true],
  ['production', '1', undefined, false],
  ['production', '1', '0', false],
  ['development', undefined, '1', true],
  ['development', undefined, undefined, false],
  ['development', '1', '1', true],
  ['test', undefined, '1', true],
  [undefined as unknown as string, undefined, '1', true],
];

for (const [NODE_ENV, RADAR_PUBLIC_DEMO, param, want] of cases) {
  assert.equal(
    canShowPublicDemo({ NODE_ENV, RADAR_PUBLIC_DEMO }, param),
    want,
    `NODE_ENV=${NODE_ENV} RADAR_PUBLIC_DEMO=${RADAR_PUBLIC_DEMO} demo=${param}`,
  );
}
console.log('radar-demo: ok');
