/**
 * The account export must cover every table that references `user`; a new table fails this
 * test until it is added to EXPORT_TABLES or listed in EXPORT_EXCLUDED with a reason.
 */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns, is } from 'drizzle-orm';
import { PgTable as PgTableClass } from 'drizzle-orm/pg-core';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as base from '../lib/db/schema';
import { EXPORT_EXCLUDED, EXPORT_TABLES } from '../lib/legal/export-tables';
import { assert, suite, test } from './harness.mjs';

// `export *` namespaces are unreliable under tsx, so every lib/db/schema*.ts file is imported directly.
const modules: unknown[] = [base];
for (const f of readdirSync(join(process.cwd(), 'lib', 'db')).filter((n) => /^schema.*.ts$/.test(n) && n !== 'schema.ts')) {
  modules.push(await import('../lib/db/' + f.replace(/.ts$/, '')));
}
const tables = [...new Set(modules.flatMap((m) => Object.values(m as object)))].filter((v) => is(v, PgTableClass)) as PgTable[];
const referencesUser = (t: PgTable) =>
  getTableConfig(t).foreignKeys.some((fk) => getTableConfig(fk.reference().foreignTable).name === 'user');

suite('account export coverage', () => {
  test('the schema introspection sees tables and the user table', () => {
    assert(tables.length > 15, `${tables.length} tables`);
    assert(tables.some((t) => getTableConfig(t).name === 'user'));
  });

  test('every table with a foreign key to user is exported or explicitly excluded', () => {
    const exported = new Set(EXPORT_TABLES.map((e) => getTableConfig(e.table).name));
    const missing = tables
      .filter(referencesUser)
      .map((t) => getTableConfig(t).name)
      .filter((n) => !exported.has(n) && !(n in EXPORT_EXCLUDED));
    assert(missing.length === 0, `not exported and not excluded: ${missing.join(', ')}`);
  });

  test('a table reachable only through a user-owned table (one FK hop, e.g. radar_search via agent_run) is exported or excluded', () => {
    const userOwned = new Set(tables.filter(referencesUser).map((t) => getTableConfig(t).name));
    const exported = new Set(EXPORT_TABLES.map((e) => getTableConfig(e.table).name));
    const missing = tables
      .filter((t) => !referencesUser(t) && getTableConfig(t).foreignKeys.some((fk) => userOwned.has(getTableConfig(fk.reference().foreignTable).name)))
      .map((t) => getTableConfig(t).name)
      .filter((n) => !exported.has(n) && !(n in EXPORT_EXCLUDED));
    assert(missing.length === 0, `reachable via a user table, not exported and not excluded: ${missing.join(', ')}`);
    assert('radar_search' in EXPORT_EXCLUDED, 'radar_search is the known one-hop table');
  });

  test('tables with a plain user_id column and no FK (ai_call) are exported or excluded', () => {
    const exported = new Set(EXPORT_TABLES.map((e) => getTableConfig(e.table).name));
    const loose = tables
      .filter((t) => !referencesUser(t) && 'userId' in getTableColumns(t))
      .map((t) => getTableConfig(t).name)
      .filter((n) => !exported.has(n) && !(n in EXPORT_EXCLUDED));
    assert(loose.length === 0, `user_id with no FK, not exported: ${loose.join(', ')}`);
    assert(exported.has('ai_call'));
  });

  test('the ai_call export is trimmed: no ids, stage or prompt version', () => {
    const e = EXPORT_TABLES.find((x) => x.key === 'aiCalls')!;
    assert.deepEqual(e.columns, ['provider', 'model', 'inTokens', 'outTokens', 'latencyMs', 'errorClass', 'createdAt']);
  });

  test('exclusions name real tables, and nothing is both exported and excluded', () => {
    const names = new Set(tables.map((t) => getTableConfig(t).name));
    for (const n of Object.keys(EXPORT_EXCLUDED)) assert(names.has(n), `unknown excluded table ${n}`);
    for (const e of EXPORT_TABLES) assert(!(getTableConfig(e.table).name in EXPORT_EXCLUDED), e.key);
  });

  test('each entry filters by a real column and has a unique key', () => {
    const keys = new Set<string>();
    for (const e of EXPORT_TABLES) {
      const cols = getTableColumns(e.table);
      assert(e.userColumn in cols, `${e.key}: no column ${e.userColumn}`);
      for (const c of e.columns ?? []) assert(c in cols, `${e.key}: no column ${c}`);
      assert(!keys.has(e.key), `duplicate key ${e.key}`);
      keys.add(e.key);
    }
  });

  test('no export entry can carry a secret column', () => {
    const SECRET = /token|password|secret|hash|id_token|session_state/i;
    for (const e of EXPORT_TABLES) {
      const names = e.columns ?? Object.values(getTableColumns(e.table)).map((c) => c.name);
      // content_hash is a fingerprint of the user's own record, not a credential.
      const bad = names.filter((n) => SECRET.test(n) && n !== 'content_hash' && n !== 'budget_tokens' && n !== 'budgetTokens' && n !== 'tokens' && n !== 'inTokens' && n !== 'outTokens' && n !== 'contentHash' && n !== 'record_hash_snapshot' && n !== 'recordHashSnapshot');
      assert(bad.length === 0, `${e.key} exports ${bad.join(', ')}`);
    }
  });
});
