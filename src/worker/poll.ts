import type { Config } from '../config.ts';
import { bumpCounter, getState, setState } from '../db.ts';
import type { Db, Queryable } from '../db.ts';
import { UpstreamError } from '../asu/client.ts';
import type { SeatSource } from '../asu/client.ts';
import type { SectionSnapshot } from '../asu/parse.ts';
import { enqueue } from '../queue.ts';
import { errorMessage, log } from '../log.ts';
import { metrics } from '../metrics.ts';

export interface PollerState {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  breakerUntil: string | null;
}

export const POLLER_STATE_KEY = 'poller';
const EMPTY: PollerState = { lastSuccessAt: null, lastFailureAt: null, lastError: null, consecutiveFailures: 0, breakerUntil: null };

export async function readPollerState(db: Queryable): Promise<PollerState> {
  return (await getState<PollerState>(db, POLLER_STATE_KEY)) ?? EMPTY;
}

export function breakerIsOpen(state: PollerState, now = Date.now()): boolean {
  return state.breakerUntil !== null && Date.parse(state.breakerUntil) > now;
}

/** Applies one snapshot atomically: seat changes, detected openings and queued deliveries commit together. */
export async function applySnapshot(
  db: Db,
  config: Config,
  courseId: number,
  snapshot: SectionSnapshot[],
): Promise<{ openings: number; notifications: number }> {
  return db.tx(async (tx) => {
    await tx.query(
      `UPDATE courses
          SET title = COALESCE($2, title), last_polled_at = now(), last_success_at = now(),
              last_section_count = $3, last_error = NULL
        WHERE id = $1`,
      [courseId, snapshot[0]?.title ?? null, snapshot.length],
    );

    // An empty result for a course we have seen means upstream had a bad moment,
    // not that every section vanished. Existing seat counts stay untouched.
    if (snapshot.length === 0) return { openings: 0, notifications: 0 };

    const { rows: existing } = await tx.query<{ id: number; class_nbr: string; open_seats: number }>(
      'SELECT id, class_nbr, open_seats FROM sections WHERE course_id = $1 FOR UPDATE',
      [courseId],
    );
    const before = new Map(existing.map((r) => [r.class_nbr, r]));
    let openings = 0;
    let notifications = 0;

    for (const s of snapshot) {
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO sections (course_id, class_nbr, title, instructors, days, start_time, end_time, location,
                               session_code, enrolled, capacity, open_seats)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (course_id, class_nbr) DO UPDATE SET
           title = EXCLUDED.title, instructors = EXCLUDED.instructors, days = EXCLUDED.days,
           start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, location = EXCLUDED.location,
           session_code = EXCLUDED.session_code, enrolled = EXCLUDED.enrolled, capacity = EXCLUDED.capacity,
           open_seats = EXCLUDED.open_seats, last_seen_at = now(),
           last_changed_at = CASE WHEN sections.open_seats <> EXCLUDED.open_seats THEN now() ELSE sections.last_changed_at END
         RETURNING id`,
        [courseId, s.classNbr, s.title, s.instructors, s.days, s.startTime, s.endTime, s.location, s.sessionCode, s.enrolled, s.capacity, s.openSeats],
      );
      const sectionId = rows[0]!.id;
      const previous = before.get(s.classNbr);

      // Only a section we previously saw full can "open". First sightings are a baseline.
      if (!previous || previous.open_seats !== 0 || s.openSeats === 0) continue;

      const { rows: opening } = await tx.query<{ id: number }>(
        'INSERT INTO seat_openings (section_id, open_seats) VALUES ($1, $2) RETURNING id',
        [sectionId, s.openSeats],
      );
      const openingId = opening[0]!.id;
      openings += 1;

      const { rows: watches } = await tx.query<{ id: number; user_id: number; email_enabled: boolean }>(
        `SELECT w.id, w.user_id, u.email_enabled
           FROM watches w JOIN users u ON u.id = w.user_id
          WHERE w.course_id = $1 AND w.active
            AND (w.section_id = $2 OR w.section_id IS NULL)
            AND (w.last_notified_at IS NULL OR w.last_notified_at < now() - ($3::double precision * interval '1 millisecond'))
          FOR UPDATE OF w`,
        [courseId, sectionId, config.polling.alertCooldownMs],
      );

      for (const watch of watches) {
        const { rows: subs } = await tx.query<{ id: number }>('SELECT id FROM push_subscriptions WHERE user_id = $1', [watch.user_id]);
        const targets: Array<['email' | 'push', number | null]> = subs.map((sub) => ['push', sub.id]);
        if (watch.email_enabled) targets.push(['email', null]);

        for (const [channel, subscriptionId] of targets) {
          const { rows: created } = await tx.query<{ id: number }>(
            `INSERT INTO notifications (opening_id, watch_id, channel, push_subscription_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (opening_id, watch_id, channel, COALESCE(push_subscription_id, 0)) DO NOTHING
             RETURNING id`,
            [openingId, watch.id, channel, subscriptionId],
          );
          if (created[0]) {
            await enqueue(tx, 'send_notification', { notificationId: created[0].id }, { maxAttempts: 6, priority: 10 });
            notifications += 1;
          }
        }
        await tx.query('UPDATE watches SET last_notified_at = now() WHERE id = $1', [watch.id]);
      }
    }
    return { openings, notifications };
  });
}

export interface Poller {
  /** True if the upstream may be called right now. */
  canPoll(): Promise<boolean>;
  poll(courseId: number): Promise<void>;
}

export function createPoller(db: Db, config: Config, source: SeatSource): Poller {
  let nextRequestAt = 0;

  async function respectSpacing(): Promise<void> {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextRequestAt = Date.now() + config.polling.minSpacingMs;
  }

  async function recordSuccess(): Promise<void> {
    const state = await readPollerState(db);
    const now = new Date();
    await setState(db, POLLER_STATE_KEY, { ...state, lastSuccessAt: now.toISOString(), consecutiveFailures: 0, breakerUntil: null, lastError: null });
    await bumpCounter(db, 'polls_ok');
    metrics.lastPollSuccess.set(now.getTime() / 1000);
    metrics.breakerOpen.set(0);
  }

  async function recordFailure(courseId: number, err: unknown): Promise<void> {
    const message = errorMessage(err);
    const state = await readPollerState(db);
    const failures = state.consecutiveFailures + 1;
    const retryAfterMs = err instanceof UpstreamError ? err.retryAfterMs : null;
    const refused = err instanceof UpstreamError && (err.status === 401 || err.status === 403 || err.status === 429);

    let breakerUntil: string | null = state.breakerUntil;
    if (retryAfterMs !== null || refused || failures >= config.polling.breakerThreshold) {
      const exponent = Math.max(0, failures - config.polling.breakerThreshold);
      const backoff = Math.min(config.polling.breakerMaxMs, config.polling.breakerBaseMs * 2 ** exponent);
      breakerUntil = new Date(Date.now() + Math.max(backoff, retryAfterMs ?? 0)).toISOString();
      log.warn('upstream polling paused', { until: breakerUntil, failures, error: message });
      metrics.breakerOpen.set(1);
    }
    await setState(db, POLLER_STATE_KEY, { ...state, lastFailureAt: new Date().toISOString(), lastError: message.slice(0, 300), consecutiveFailures: failures, breakerUntil });
    await db.query('UPDATE courses SET last_polled_at = now(), last_error = $2 WHERE id = $1', [courseId, message.slice(0, 300)]);
    await bumpCounter(db, 'polls_failed');
  }

  return {
    async canPoll() {
      return config.polling.enabled && !breakerIsOpen(await readPollerState(db));
    },

    async poll(courseId) {
      const { rows } = await db.query<{ term: string; subject: string; catalog_nbr: string }>(
        'SELECT term, subject, catalog_nbr FROM courses WHERE id = $1',
        [courseId],
      );
      const course = rows[0];
      if (!course) return;

      await respectSpacing();
      const started = performance.now();
      let snapshot: SectionSnapshot[];
      try {
        snapshot = await source({ term: course.term, subject: course.subject, catalogNbr: course.catalog_nbr });
      } catch (err) {
        metrics.polls.inc({ outcome: 'failed' });
        log.warn('seat check failed', { courseId, error: errorMessage(err) });
        // Not rethrown: the scheduler is the retry policy, so failures can't stack extra upstream load.
        await recordFailure(courseId, err);
        return;
      }
      metrics.pollDuration.observe((performance.now() - started) / 1000);
      metrics.polls.inc({ outcome: 'ok' });

      const result = await applySnapshot(db, config, courseId, snapshot);
      await recordSuccess();
      if (result.openings > 0) {
        metrics.openings.inc({}, result.openings);
        log.info('seats opened', { courseId, ...result });
      }
    },
  };
}

/**
 * Enqueues checks for due courses. The revisit interval stretches with the
 * number of tracked courses, so upstream request rate stays constant as usage grows.
 */
export async function scheduleDuePolls(db: Db, config: Config, tickMs: number): Promise<number> {
  return db.tx(async (tx) => {
    const { rows: countRows } = await tx.query<{ n: number }>(
      `SELECT count(DISTINCT w.course_id)::int AS n FROM watches w
         JOIN courses c ON c.id = w.course_id
        WHERE w.active AND c.term = ANY($1::text[])`,
      [config.terms.map((t) => t.code)],
    );
    const tracked = countRows[0]?.n ?? 0;
    const spacing = Math.max(config.polling.minSpacingMs, 1);
    const intervalMs = Math.max(config.polling.intervalMs, tracked * spacing);
    const batch = Math.max(1, Math.ceil(tickMs / spacing));

    const { rows } = await tx.query<{ id: number }>(
      `SELECT c.id FROM courses c
        WHERE c.next_poll_at <= now()
          AND c.term = ANY($1::text[])
          AND EXISTS (SELECT 1 FROM watches w WHERE w.course_id = c.id AND w.active)
        ORDER BY c.next_poll_at
        LIMIT $2
        FOR UPDATE OF c SKIP LOCKED`,
      [config.terms.map((t) => t.code), batch],
    );
    for (const row of rows) {
      await tx.query(
        `UPDATE courses SET next_poll_at = now() + ($2::double precision * interval '1 millisecond') WHERE id = $1`,
        [row.id, intervalMs],
      );
      await enqueue(tx, 'poll_course', { courseId: row.id }, { dedupeKey: `poll:${row.id}`, maxAttempts: 1 });
    }
    return rows.length;
  });
}
