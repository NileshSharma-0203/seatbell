import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { errorMessage, log } from '../log.ts';
import { metrics } from '../metrics.ts';
import { claim, complete, fail, purgeFinished, reapExpired } from '../queue.ts';
import type { Job } from '../queue.ts';
import type { Senders } from '../notify/send.ts';
import type { SeatSource } from '../asu/client.ts';
import { createPoller, scheduleDuePolls } from './poll.ts';
import { deliverNotification, markExhausted, sendTestAlert } from './deliver.ts';

const LEASE_MS = 60_000;
const SCHEDULER_TICK_MS = 5_000;

export interface Worker {
  stop(): Promise<void>;
}

export function startWorker(db: Db, config: Config, source: SeatSource, senders: Senders, notifyConcurrency = 4): Worker {
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const poller = createPoller(db, config, source);
  let stopping = false;
  const shouldStop = () => stopping;

  const sleepers = new Set<() => void>();
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });

  async function repeat(name: string, intervalMs: number, fn: () => Promise<unknown>, stop: () => boolean): Promise<void> {
    while (!stop()) {
      try {
        await fn();
      } catch (err) {
        log.error(`${name} failed`, { error: errorMessage(err) });
      }
      await sleep(intervalMs);
    }
  }

  async function run(job: Job): Promise<void> {
    const payload = job.payload as Record<string, number>;
    switch (job.kind) {
      case 'poll_course':
        return poller.poll(payload.courseId!);
      case 'send_notification':
        return deliverNotification(db, config, senders, payload.notificationId!);
      case 'send_test':
        return sendTestAlert(db, config, senders, payload.userId!);
      default:
        throw new Error(`unknown job kind ${job.kind}`);
    }
  }

  async function consume(kinds: string[], idleMs: number, gate?: () => Promise<boolean>): Promise<void> {
    while (!stopping) {
      let job: Job | null = null;
      try {
        if (!gate || (await gate())) job = await claim(db, kinds, workerId, LEASE_MS);
      } catch (err) {
        log.error('claim failed', { error: errorMessage(err) });
      }
      if (!job) {
        await sleep(idleMs);
        continue;
      }
      try {
        await run(job);
        await complete(db, job, workerId);
        metrics.jobs.inc({ kind: job.kind, outcome: 'done' });
      } catch (err) {
        const message = errorMessage(err);
        const outcome = await fail(db, job, workerId, message).catch(() => 'lost' as const);
        metrics.jobs.inc({ kind: job.kind, outcome });
        log.warn('job failed', { id: job.id, kind: job.kind, attempt: job.attempts, outcome, error: message });
        if (outcome === 'dead' && job.kind === 'send_notification') {
          await markExhausted(db, (job.payload as { notificationId: number }).notificationId, message).catch(() => undefined);
        }
      }
    }
  }

  async function sampleGauges(): Promise<void> {
    const { rows: depth } = await db.query<{ kind: string; status: string; n: number }>(
      `SELECT kind, status, count(*)::int AS n FROM jobs WHERE status IN ('queued','running') GROUP BY kind, status`,
    );
    for (const kind of ['poll_course', 'send_notification', 'send_test']) {
      for (const status of ['queued', 'running']) {
        metrics.queueDepth.set(depth.find((d) => d.kind === kind && d.status === status)?.n ?? 0, { kind, status });
      }
    }
    const { rows } = await db.query<{ oldest: number; watches: number; courses: number }>(
      `SELECT COALESCE((SELECT EXTRACT(EPOCH FROM now() - min(run_at))::float8 FROM jobs WHERE status = 'queued' AND run_at <= now()), 0) AS oldest,
              (SELECT count(*)::int FROM watches WHERE active) AS watches,
              (SELECT count(DISTINCT course_id)::int FROM watches WHERE active) AS courses`,
    );
    metrics.queueOldest.set(rows[0]?.oldest ?? 0);
    metrics.activeWatches.set(rows[0]?.watches ?? 0);
    metrics.trackedCourses.set(rows[0]?.courses ?? 0);
  }

  async function maintain(): Promise<void> {
    await purgeFinished(db, 7);
    await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
    await db.query(`DELETE FROM login_codes WHERE created_at < now() - interval '1 day'`);
    await db.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
  }

  const loops = [
    repeat('scheduler', SCHEDULER_TICK_MS, async () => {
      if (await poller.canPoll()) await scheduleDuePolls(db, config, SCHEDULER_TICK_MS);
    }, shouldStop),
    repeat('reaper', 15_000, () => reapExpired(db), shouldStop),
    repeat('gauges', 15_000, sampleGauges, shouldStop),
    repeat('maintenance', 3_600_000, maintain, shouldStop),
    // Exactly one upstream consumer: request spacing is enforced in this loop.
    consume(['poll_course'], 300, () => poller.canPoll()),
    ...Array.from({ length: notifyConcurrency }, () => consume(['send_notification', 'send_test'], 300)),
  ];

  return {
    async stop() {
      stopping = true;
      for (const wake of [...sleepers]) wake();
      // In-flight jobs finish; anything slower than this is recovered by its lease.
      await Promise.race([Promise.all(loops), new Promise((resolve) => setTimeout(resolve, 12_000).unref())]);
    },
  };
}
