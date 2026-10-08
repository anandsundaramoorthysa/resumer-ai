/**
 * One guard for every state-changing route: same-origin (CSRF), content type, body size.
 * (lib/radar/handlers.ts keeps its own equivalent; the Origin rule below is the same.)
 *
 *   const refused = guardMutation(req, { contentTypes: ['application/json'], maxBytes: JSON_MAX });
 *   if (refused) return refused;
 *   const body = await readJsonLimited(req, JSON_MAX);   // cap enforced while reading
 *   if (!body.ok) return body.res;
 *
 * An absent Origin is allowed (curl, server-to-server: not a browser cross-site request); a
 * foreign or "null" Origin is refused before any work or AI call. A request with no body at
 * all skips the content-type check (the sync start, the improve pass).
 */

const err = (error: string, status: number) => Response.json({ error }, { status });

/** Ids in URLs: a Postgres text column throws on NUL, so anything odd is a 404 before a query. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isSafeId = (id: unknown): id is string => typeof id === 'string' && SAFE_ID.test(id);

export const JSON_MAX_BYTES = 256 * 1024;

function authHost(): string[] {
  try {
    return process.env.AUTH_URL ? [new URL(process.env.AUTH_URL).host] : [];
  } catch {
    return [];
  }
}

export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false; // includes the literal "null"
  }
  const allowed = [req.headers.get('host'), req.headers.get('x-forwarded-host'), ...authHost()]
    .flatMap((h) => (h ? h.split(',') : []))
    .map((h) => h.trim().toLowerCase());
  return allowed.includes(host);
}

export function guardMutation(
  req: Request,
  o: { contentTypes: string[]; maxBytes: number },
): Response | null {
  if (!isSameOrigin(req)) return err('Cross-site requests are not allowed.', 403);

  const length = req.headers.get('content-length');
  const hasBody = req.body !== null && length !== '0';
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (hasBody && !o.contentTypes.some((t) => type.includes(t))) {
    return err('Unsupported content type.', 415);
  }
  if (length !== null) {
    const n = Number(length);
    if (!Number.isFinite(n) || n < 0) return err('Invalid Content-Length.', 400);
    if (n > o.maxBytes) return err('That request is too large.', 413);
  } else if (hasBody && type.includes('multipart/form-data')) {
    // formData() buffers everything, so an undeclared length cannot be bounded up front.
    return err('Upload size must be declared.', 411);
  }
  return null;
}

/** Reads at most `maxBytes`, cancelling the stream as soon as the cap is crossed. */
export async function readTextLimited(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; res: Response }> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, res: err('That request is too large.', 413) };
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, res: err('That request is too large.', 413) };
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/** Empty body -> `{}`; malformed JSON -> 400. */
export async function readJsonLimited(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const r = await readTextLimited(req, maxBytes);
  if (!r.ok) return r;
  if (r.text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(r.text) };
  } catch {
    return { ok: false, res: err('The request body must be valid JSON.', 400) };
  }
}
