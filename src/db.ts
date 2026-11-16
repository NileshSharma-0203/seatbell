import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.ts';

// Row shapes are asserted at each call site's generic parameter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export interface Queryable {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
  });
  pool.on('error', (err: Error) => log.error('postgres idle client error', { error: err.message }));

  return {
    query: <T extends Row = Row>(text: string, params?: unknown[]) =>
      pool.query(text, params as unknown[]) as unknown as Promise<{ rows: T[]; rowCount: number | null }>,
    async tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client as unknown as Queryable);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_LOCK = 717_001;

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  return db.tx(async (tx) => {
    // Transaction-scoped: replicas that start together run migrations one at a time.
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await tx.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.query(await readFile(path.join(dir, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    }
    return applied;
  });
}

const TODAY = "(now() AT TIME ZONE 'America/Phoenix')::date";

export async function bumpCounter(db: Queryable, name: string, by = 1): Promise<void> {
  await db.query(
    `INSERT INTO daily_counters (day, name, value) VALUES (${TODAY}, $1, $2)
     ON CONFLICT (day, name) DO UPDATE SET value = daily_counters.value + EXCLUDED.value`,
    [name, by],
  );
}

export async function markActive(db: Queryable, userId: number): Promise<void> {
  await db.query(`INSERT INTO daily_active (day, user_id) VALUES (${TODAY}, $1) ON CONFLICT DO NOTHING`, [userId]);
}

export async function setState(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function getState<T>(db: Queryable, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>('SELECT value FROM system_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
