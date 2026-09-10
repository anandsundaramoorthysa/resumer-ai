/**
 * The pure-JavaScript DOMMatrix that lets pdfjs load where no native canvas exists —
 * lib/render/dommatrix.ts.
 *
 * It is installed on globalThis, so it has to be right rather than merely present: any
 * library that feature-detects DOMMatrix would receive it. Where the native
 * implementation does load — the @napi-rs/canvas binary on a developer machine — every
 * operation pdfjs uses is cross-checked against it, so the two cannot quietly disagree.
 */

import { createRequire } from 'node:module';
import { DOMMatrix2D, ensureDOMMatrix } from '../lib/render/dommatrix';
import { suite, test, assert } from './harness.mjs';

interface M2 {
  a: number; b: number; c: number; d: number; e: number; f: number;
  multiply(o: M2): M2;
  preMultiplySelf(o: M2): M2;
  invertSelf(): M2;
  translate(x: number, y: number): M2;
  scale(x: number, y?: number): M2;
}
type Ctor = new (init?: number[]) => M2;

const KEYS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const close = (x: number, y: number) => (Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) < 1e-9;
const same = (m: M2, n: M2) => KEYS.every((k) => close(m[k], n[k]));

suite('DOMMatrix2D — a correct 2D affine matrix', () => {
  test('identity by default, which is all pdfjs asks for at module load', () => {
    assert.ok(new DOMMatrix2D().isIdentity);
  });

  test('translate moves a point', () => {
    const p = new DOMMatrix2D().translate(10, 20).transformPoint({ x: 1, y: 2 });
    assert.equal(p.x, 11);
    assert.equal(p.y, 22);
  });

  test('scale with one argument scales both axes', () => {
    const p = new DOMMatrix2D().scale(3).transformPoint({ x: 1, y: 2 });
    assert.equal(p.x, 3);
    assert.equal(p.y, 6);
  });

  test('the argument of a multiply applies first, as the DOM specifies', () => {
    // translate(10).scale(2): the scale reaches the point first, then the translate.
    const p = new DOMMatrix2D().translate(10, 0).scale(2).transformPoint({ x: 1, y: 0 });
    assert.equal(p.x, 12);
  });

  test('preMultiplySelf is the reverse order of multiplySelf', () => {
    const t = new DOMMatrix2D([1, 0, 0, 1, 10, 0]);
    const s = new DOMMatrix2D([2, 0, 0, 2, 0, 0]);
    assert.equal(s.clone().preMultiplySelf(t).transformPoint({ x: 1 }).x, 12);
    assert.equal(s.clone().multiplySelf(t).transformPoint({ x: 1 }).x, 22);
  });

  test('a matrix times its inverse is the identity', () => {
    const m = new DOMMatrix2D([2, 1, -1, 3, 5, -7]);
    const id = m.multiply(m.inverse());
    assert.ok(same(id, new DOMMatrix2D()), 'm × m⁻¹ must be the identity');
  });

  test('a singular matrix inverts to NaN, as the DOM specifies', () => {
    const inv = new DOMMatrix2D([1, 2, 2, 4, 0, 0]).invertSelf();
    assert.ok(KEYS.every((k) => Number.isNaN(inv[k])));
  });

  test('a 16-value initialiser reads the 2D entries', () => {
    const m = new DOMMatrix2D([2, 3, 0, 0, 4, 5, 0, 0, 0, 0, 1, 0, 6, 7, 0, 1]);
    assert.deepEqual([m.a, m.b, m.c, m.d, m.e, m.f], [2, 3, 4, 5, 6, 7]);
  });

  test('a 3D operation is refused loudly, not approximated', () => {
    assert.throws(() => new DOMMatrix2D().translate(0, 0, 1));
    assert.throws(() => new DOMMatrix2D('matrix(1,0,0,1,0,0)'));
  });

  test('ensureDOMMatrix never replaces an implementation that already exists', () => {
    const g = globalThis as { DOMMatrix?: unknown };
    const original = g.DOMMatrix;
    try {
      const sentinel = function Native() {};
      g.DOMMatrix = sentinel;
      assert.equal(ensureDOMMatrix(), 'native');
      assert.equal(g.DOMMatrix, sentinel, 'a real DOMMatrix must survive');

      delete g.DOMMatrix;
      assert.equal(ensureDOMMatrix(), 'polyfilled');
      assert.equal(g.DOMMatrix, DOMMatrix2D);
    } finally {
      if (original === undefined) delete g.DOMMatrix;
      else g.DOMMatrix = original;
    }
  });
});

suite('DOMMatrix2D — agrees with the native implementation wherever one loads', () => {
  let Native: Ctor | null = null;
  try {
    Native = createRequire(import.meta.url)('@napi-rs/canvas').DOMMatrix as Ctor;
  } catch {
    Native = null;
  }

  test('every operation pdfjs uses matches the native result', () => {
    if (!Native) {
      console.log('    (the native canvas does not load here, so there is nothing to compare against)');
      return;
    }
    const Poly = DOMMatrix2D as unknown as Ctor;
    const init = [2, 0.5, -1, 3, 5, -7];
    const other = [1, 2, 3, 4, 5, 6];
    const cases: Array<[string, (M: Ctor) => M2]> = [
      ['multiply', (M) => new M(init).multiply(new M(other))],
      ['preMultiplySelf', (M) => new M(init).preMultiplySelf(new M(other))],
      ['invertSelf', (M) => new M(init).invertSelf()],
      ['translate', (M) => new M(init).translate(3, -4)],
      ['scale', (M) => new M(init).scale(2, -3)],
      [
        'the chain pdfjs builds for glyph paths',
        (M) => new M(init).preMultiplySelf(new M([1, 0, 0, 1, 2, 3])).translate(4, 5).scale(12, -12),
      ],
    ];
    for (const [name, op] of cases) {
      assert.ok(same(op(Poly), op(Native)), `${name} disagrees with the native DOMMatrix`);
    }
  });
});
