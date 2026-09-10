/**
 * A pure-JavaScript DOMMatrix, installed only where the runtime has none.
 *
 * PDF reading failed on every upload in production, and the function log said why:
 *
 *     Failed to load external module pdf-parse: ReferenceError: DOMMatrix is not defined
 *
 * pdf-parse is built on pdfjs, and pdfjs evaluates `const SCALE_MATRIX = new DOMMatrix();`
 * at the top level of the module. Node has no DOMMatrix. pdfjs tries to borrow one from
 * the native `@napi-rs/canvas` package, and on a developer's machine that works, because
 * the platform binary is installed. On Netlify's Lambda the binary is not in the function
 * bundle — the package picks it with a platform-dependent require that build-time file
 * tracing cannot follow — so pdfjs only warns, carries on, and dies one line later. Every
 * PDF resume import and every PDF job description was refused, with a message telling the
 * user their file was probably a scan.
 *
 * Text extraction never draws anything; every other DOMMatrix use in pdfjs is inside
 * canvas rendering. So instead of shipping a native graphics binary to read text, the one
 * thing pdfjs needs at load time is supplied here. It is a real, correct 2D affine matrix
 * rather than a stub, because once it is on `globalThis` any other library that
 * feature-detects DOMMatrix would receive it — and a stub would hand that library silently
 * wrong geometry instead of an honest absence.
 *
 * Only the 2D subset is implemented, which is all pdfjs uses. A 3D operation is refused
 * loudly rather than approximated.
 */

type Point = { x?: number; y?: number; z?: number; w?: number };
type Matrix2DLike = { a: number; b: number; c: number; d: number; e: number; f: number };

export class DOMMatrix2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  /** Accepts the six 2D values [a, b, c, d, e, f], or the 16 of a 4x4 that is 2D. */
  constructor(init?: ArrayLike<number> | string) {
    if (init === undefined) return;
    if (typeof init === 'string') {
      throw new TypeError('DOMMatrix2D does not parse CSS transform strings; pass numbers.');
    }
    if (init.length === 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(init);
    } else if (init.length === 16) {
      this.a = init[0];
      this.b = init[1];
      this.c = init[4];
      this.d = init[5];
      this.e = init[12];
      this.f = init[13];
    } else {
      throw new TypeError(`DOMMatrix needs 6 or 16 values, got ${init.length}.`);
    }
  }

  get m11() { return this.a; }
  get m12() { return this.b; }
  get m21() { return this.c; }
  get m22() { return this.d; }
  get m41() { return this.e; }
  get m42() { return this.f; }
  get is2D() { return true; }
  get isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }

  clone(): DOMMatrix2D {
    return new DOMMatrix2D([this.a, this.b, this.c, this.d, this.e, this.f]);
  }

  private set(m: Matrix2DLike): this {
    this.a = m.a;
    this.b = m.b;
    this.c = m.c;
    this.d = m.d;
    this.e = m.e;
    this.f = m.f;
    return this;
  }

  /** this = this × other — `other` applies first, as the DOM specifies. */
  multiplySelf(o: Matrix2DLike): this {
    return this.set({
      a: this.a * o.a + this.c * o.b,
      b: this.b * o.a + this.d * o.b,
      c: this.a * o.c + this.c * o.d,
      d: this.b * o.c + this.d * o.d,
      e: this.a * o.e + this.c * o.f + this.e,
      f: this.b * o.e + this.d * o.f + this.f,
    });
  }

  /** this = other × this. */
  preMultiplySelf(o: Matrix2DLike): this {
    return this.set(new DOMMatrix2D([o.a, o.b, o.c, o.d, o.e, o.f]).multiplySelf(this));
  }

  multiply(o: Matrix2DLike): DOMMatrix2D {
    return this.clone().multiplySelf(o);
  }

  translateSelf(tx = 0, ty = 0, tz = 0): this {
    if (tz !== 0) throw new TypeError('DOMMatrix2D is 2D only: a z translation is not supported.');
    return this.multiplySelf(new DOMMatrix2D([1, 0, 0, 1, tx, ty]));
  }

  translate(tx = 0, ty = 0, tz = 0): DOMMatrix2D {
    return this.clone().translateSelf(tx, ty, tz);
  }

  scaleSelf(sx = 1, sy: number = sx): this {
    return this.multiplySelf(new DOMMatrix2D([sx, 0, 0, sy, 0, 0]));
  }

  scale(sx = 1, sy: number = sx): DOMMatrix2D {
    return this.clone().scaleSelf(sx, sy);
  }

  /** A matrix that cannot be inverted becomes all NaN, as the DOM specifies. */
  invertSelf(): this {
    const det = this.a * this.d - this.b * this.c;
    if (det === 0 || !Number.isFinite(det)) {
      return this.set({ a: NaN, b: NaN, c: NaN, d: NaN, e: NaN, f: NaN });
    }
    return this.set({
      a: this.d / det,
      b: -this.b / det,
      c: -this.c / det,
      d: this.a / det,
      e: (this.c * this.f - this.d * this.e) / det,
      f: (this.b * this.e - this.a * this.f) / det,
    });
  }

  inverse(): DOMMatrix2D {
    return this.clone().invertSelf();
  }

  transformPoint(p: Point = {}): Required<Point> {
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: p.z ?? 0, w: p.w ?? 1 };
  }

  toFloat64Array(): Float64Array {
    return new Float64Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]);
  }
}

/**
 * Installs DOMMatrix2D on `globalThis` if, and only if, there is no DOMMatrix already.
 *
 * A real implementation — a browser's, or the native canvas package's where it loads —
 * is never replaced. Call it before importing pdf-parse: pdfjs reads DOMMatrix when its
 * module is evaluated, so a polyfill installed afterwards is too late.
 */
export function ensureDOMMatrix(): 'native' | 'polyfilled' {
  const g = globalThis as { DOMMatrix?: unknown };
  if (typeof g.DOMMatrix === 'function') return 'native';
  g.DOMMatrix = DOMMatrix2D;
  return 'polyfilled';
}
