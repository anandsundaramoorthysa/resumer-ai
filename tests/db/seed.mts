/** Small row builders for the `db-*` suites. Plain inserts: no application code involved. */
import type { PGlite } from '@electric-sql/pglite';

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

export async function mkUser(pg: PGlite, id = uid('u'), extra: { email?: string; verified?: boolean; approval?: string } = {}) {
  await pg.query(
    `insert into "user" (id, email, "emailVerified", approval) values ($1, $2, $3, $4) on conflict do nothing`,
    [id, extra.email ?? null, extra.verified ? new Date() : null, extra.approval ?? 'pending'],
  );
  return id;
}

export async function mkRecord(
  pg: PGlite,
  userId: string,
  over: {
    id?: string;
    type?: string;
    source?: string;
    state?: string;
    hash?: string;
    data?: Record<string, unknown>;
  } = {},
) {
  const id = over.id ?? uid('rec');
  await pg.query(
    `insert into profile_record (id, user_id, type, source, content_hash, tags, data, review_state)
     values ($1,$2,$3,$4,$5,'[]'::jsonb,$6::jsonb,$7)`,
    [id, userId, over.type ?? 'skill', over.source ?? 'github-sync', over.hash ?? `h-${id}`, JSON.stringify(over.data ?? { name: id, category: 'tool' }), over.state ?? 'pending'],
  );
  return id;
}

export async function mkRole(pg: PGlite, userId: string, over: { id?: string; state?: string; title?: string; company?: string; source?: string } = {}) {
  const id = over.id ?? uid('role');
  await pg.query(
    `insert into role (id, user_id, title, company, start_date, end_date, source, content_hash, review_state)
     values ($1,$2,$3,$4,'2020-01','present',$5,$6,$7)`,
    [id, userId, over.title ?? 'Engineer', over.company ?? 'Acme', over.source ?? 'github-sync', `h-${id}`, over.state ?? 'pending'],
  );
  return id;
}

export async function one<T = Record<string, unknown>>(pg: PGlite, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await pg.query<T>(sql, params)).rows[0];
}
export async function all<T = Record<string, unknown>>(pg: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
