import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

/** Both drivers expose the same query builder; we type against the pglite flavour. */
export type DB = ReturnType<typeof drizzlePglite<typeof schema>>;

export interface Database {
  db: DB;
  close(): Promise<void>;
}

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * `postgres://…` → node-postgres pool (production).
 * `pglite://memory` → in-memory Postgres (tests). `pglite://<dir>` → embedded Postgres on disk (local dev).
 */
export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    if (target !== 'memory') mkdirSync(target, { recursive: true });
    const client = new PGlite(target === 'memory' ? undefined : target);
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder: MIGRATIONS });
    return { db, close: () => client.close() };
  }
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const db = drizzlePg(pool, { schema });
  await migratePg(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as DB, close: () => pool.end() };
}
