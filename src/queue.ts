import type { Queryable } from './db.ts';

export interface Job<P = Record<string, unknown>> {
  id: string;
  kind: string;
  payload: P;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  dedupeKey?: string;
  priority?: number;
  delayMs?: number;
  maxAttempts?: number;
}

/**
 * Enqueue inside the caller's transaction when the job must commit atomically
 * with the state that caused it. Returns false if an identical job is already
 * queued or running.
 */
export async function enqueue(db: Queryable, kind: string, payload: unknown, opts: EnqueueOptions = {}): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO jobs (kind, payload, dedupe_key, priority, run_at, max_attempts)
     VALUES ($1, $2, $3, $4, now() + ($5::double precision * interval '1 millisecond'), $6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING`,
    [kind, JSON.stringify(payload), opts.dedupeKey ?? null, opts.priority ?? 0, opts.delayMs ?? 0, opts.maxAttempts ?? 5],
  );
  return rowCount === 1;
}

export async function claim(db: Queryable, kinds: string[], workerId: string, leaseMs: number): Promise<Job | null> {
  const { rows } = await db.query<Job>(
    `UPDATE jobs
        SET status = 'running',
            locked_by = $2,
            locked_until = now() + ($3::double precision * interval '1 millisecond'),
            attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued' AND kind = ANY($1::text[]) AND run_at <= now()
         ORDER BY priority DESC, run_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING id, kind, payload, attempts, max_attempts`,
    [kinds, workerId, leaseMs],
  );
  return rows[0] ?? null;
}

/** Every transition is fenced on locked_by, so a worker whose lease expired cannot overwrite the new owner. */
export async function complete(db: Queryable, job: Job, workerId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE jobs SET status = 'done', finished_at = now(), locked_by = NULL, locked_until = NULL
      WHERE id = $1 AND status = 'running' AND locked_by = $2`,
    [job.id, workerId],
  );
  return rowCount === 1;
}

export function backoffMs(attempt: number, baseMs = 2_000, capMs = 5 * 60_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

export async function fail(db: Queryable, job: Job, workerId: string, error: string, retryable = true): Promise<'retry' | 'dead' | 'lost'> {
  const retry = retryable && job.attempts < job.max_attempts;
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET status = $3,
            run_at = CASE WHEN $3 = 'queued' THEN now() + ($4::double precision * interval '1 millisecond') ELSE run_at END,
            finished_at = CASE WHEN $3 = 'dead' THEN now() END,
            locked_by = NULL, locked_until = NULL, last_error = $5
      WHERE id = $1 AND status = 'running' AND locked_by = $2`,
    [job.id, workerId, retry ? 'queued' : 'dead', retry ? backoffMs(job.attempts) : 0, error.slice(0, 2000)],
  );
  if (rowCount !== 1) return 'lost';
  return retry ? 'retry' : 'dead';
}

/** Returns jobs from crashed workers to the queue. A job that exhausted its attempts is dead-lettered. */
export async function reapExpired(db: Queryable): Promise<{ requeued: number; dead: number }> {
  const { rows } = await db.query<{ status: string }>(
    `UPDATE jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
            finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
            last_error = 'lease expired',
            locked_by = NULL, locked_until = NULL
      WHERE status = 'running' AND locked_until < now()
      RETURNING status`,
  );
  return {
    requeued: rows.filter((r) => r.status === 'queued').length,
    dead: rows.filter((r) => r.status === 'dead').length,
  };
}

export async function purgeFinished(db: Queryable, olderThanDays: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM jobs WHERE status IN ('done', 'dead') AND finished_at < now() - ($1::int * interval '1 day')`,
    [olderThanDays],
  );
  return rowCount ?? 0;
}
