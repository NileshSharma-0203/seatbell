import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Db } from '../src/db.ts';
import { UpstreamError } from '../src/asu/client.ts';
import { ContractError } from '../src/asu/parse.ts';
import type { SectionSnapshot } from '../src/asu/parse.ts';
import { SubscriptionGoneError } from '../src/notify/send.ts';
import { claim, complete } from '../src/queue.ts';
import { deliverNotification } from '../src/worker/deliver.ts';
import { applySnapshot, breakerIsOpen, createPoller, readPollerState, scheduleDuePolls } from '../src/worker/poll.ts';
import { fakeSenders, freshDb, section, sectionId, seedCourse, seedUser, seedWatch, testConfig } from './helpers.ts';

let db: Db;
const config = testConfig();
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.query('TRUNCATE users, courses, jobs, system_state, daily_counters RESTART IDENTITY CASCADE');
});

async function counts(): Promise<{ notifications: number; jobs: number; openings: number }> {
  const { rows } = await db.query<{ notifications: number; jobs: number; openings: number }>(
    `SELECT (SELECT count(*)::int FROM notifications) AS notifications,
            (SELECT count(*)::int FROM jobs WHERE kind = 'send_notification') AS jobs,
            (SELECT count(*)::int FROM seat_openings) AS openings`,
  );
  return rows[0]!;
}

async function setup(): Promise<{ courseId: number; a: number; userId: number }> {
  const userId = await seedUser(db, 'a@asu.edu');
  const courseId = await seedCourse(db);
  await applySnapshot(db, config, courseId, [section('100', 30), section('200', 30)]);
  return { courseId, a: await sectionId(db, courseId, '100'), userId };
}

test('first sighting is a baseline, even when seats are open', async () => {
  const userId = await seedUser(db, 'a@asu.edu');
  const courseId = await seedCourse(db);
  await seedWatch(db, userId, courseId, null);
  await applySnapshot(db, config, courseId, [section('100', 10)]);
  assert.deepEqual(await counts(), { notifications: 0, jobs: 0, openings: 0 });
});

test('full to open queues exactly one delivery per channel, atomically', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await db.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.test/1', 'x', 'y')`, [userId]);
  const result = await applySnapshot(db, config, courseId, [section('100', 28), section('200', 30)]);
  assert.deepEqual(result, { openings: 1, notifications: 2 });
  assert.deepEqual(await counts(), { notifications: 2, jobs: 2, openings: 1 });
});

test('no alert while seats stay open or counts just change', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await applySnapshot(db, config, courseId, [section('100', 28)]);
  await applySnapshot(db, config, courseId, [section('100', 27)]);
  await applySnapshot(db, config, courseId, [section('100', 29)]);
  assert.equal((await counts()).openings, 1);
});

test('flapping within the cooldown alerts once, and alerts again after it', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await applySnapshot(db, config, courseId, [section('100', 29)]);
  await applySnapshot(db, config, courseId, [section('100', 30)]);
  await applySnapshot(db, config, courseId, [section('100', 29)]);
  assert.equal((await counts()).notifications, 1);
  await db.query(`UPDATE watches SET last_notified_at = now() - interval '1 hour'`);
  await applySnapshot(db, config, courseId, [section('100', 30)]);
  await applySnapshot(db, config, courseId, [section('100', 29)]);
  assert.equal((await counts()).notifications, 2);
});

test('an any-section watch gets one alert when several sections open together', async () => {
  const { courseId, userId } = await setup();
  await seedWatch(db, userId, courseId, null);
  await applySnapshot(db, config, courseId, [section('100', 28), section('200', 25)]);
  assert.equal((await counts()).notifications, 1);
});

test('watching section A does not alert for section B', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await applySnapshot(db, config, courseId, [section('100', 30), section('200', 25)]);
  assert.equal((await counts()).notifications, 0);
});

test('stopped watches and disabled email produce nothing', async () => {
  const { courseId, a, userId } = await setup();
  const id = await seedWatch(db, userId, courseId, a);
  await db.query('UPDATE watches SET active = false WHERE id = $1', [id]);
  await applySnapshot(db, config, courseId, [section('100', 28)]);
  await applySnapshot(db, config, courseId, [section('100', 30)]);
  await db.query('UPDATE watches SET active = true WHERE id = $1', [id]);
  await db.query('UPDATE users SET email_enabled = false');
  await applySnapshot(db, config, courseId, [section('100', 28)]);
  assert.equal((await counts()).notifications, 0);
});

test('an empty upstream response leaves seat data alone and cannot trigger an alert', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await applySnapshot(db, config, courseId, []);
  await applySnapshot(db, config, courseId, [section('100', 30)]);
  assert.equal((await counts()).openings, 0);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM sections WHERE course_id = $1', [courseId]);
  assert.equal(rows[0]!.n, 2);
});

test('a failure part-way through rolls back the seat update too, so the opening is detected on retry', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await assert.rejects(applySnapshot(db, config, courseId, [
    section('100', 28),
    section('200', 30, 30, { title: 'x', classNbr: '200', enrolled: -1, openSeats: -1 } as Partial<SectionSnapshot>),
  ]));
  assert.deepEqual(await counts(), { notifications: 0, jobs: 0, openings: 0 });
  assert.equal((await applySnapshot(db, config, courseId, [section('100', 28), section('200', 30)])).notifications, 1);
});

test('two simultaneous snapshots cannot double-alert', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await Promise.all(Array.from({ length: 8 }, () => applySnapshot(db, config, courseId, [section('100', 28)])));
  const c = await counts();
  assert.equal(c.openings, 1);
  assert.equal(c.notifications, 1);
});

function pollerWith(impl: () => SectionSnapshot[]) {
  return createPoller(db, config, async () => impl());
}

test('malformed data is a failure, never a zero', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await applySnapshot(db, config, courseId, [section('100', 28)]);
  await pollerWith(() => { throw new ContractError('changed'); }).poll(courseId);
  const { rows } = await db.query('SELECT open_seats FROM sections WHERE id = $1', [a]);
  assert.equal(rows[0]!.open_seats, 2);
  assert.equal((await readPollerState(db)).consecutiveFailures, 1);
});

test('a 429 pauses all polling for at least Retry-After', async () => {
  const { courseId } = await setup();
  const poller = pollerWith(() => { throw new UpstreamError('limited', 429, 40 * 60_000); });
  assert.equal(await poller.canPoll(), true);
  await poller.poll(courseId);
  const state = await readPollerState(db);
  assert.ok(Date.parse(state.breakerUntil!) > Date.now() + 39 * 60_000);
  assert.equal(await poller.canPoll(), false);
});

test('a 429 without Retry-After still pauses immediately', async () => {
  const { courseId } = await setup();
  await pollerWith(() => { throw new UpstreamError('limited', 429); }).poll(courseId);
  assert.equal(breakerIsOpen(await readPollerState(db)), true);
});

test('a 403 pauses immediately', async () => {
  const { courseId } = await setup();
  await pollerWith(() => { throw new UpstreamError('no', 403); }).poll(courseId);
  assert.equal(breakerIsOpen(await readPollerState(db)), true);
});

test('repeated errors open the breaker at the threshold and a success closes it', async () => {
  const { courseId } = await setup();
  const failing = pollerWith(() => { throw new UpstreamError('bad', 500); });
  for (let i = 0; i < config.polling.breakerThreshold - 1; i += 1) await failing.poll(courseId);
  assert.equal(breakerIsOpen(await readPollerState(db)), false);
  await failing.poll(courseId);
  assert.equal(breakerIsOpen(await readPollerState(db)), true);
  await pollerWith(() => [section('100', 30)]).poll(courseId);
  const state = await readPollerState(db);
  assert.equal(breakerIsOpen(state), false);
  assert.equal(state.consecutiveFailures, 0);
});

test('POLLING_ENABLED=false stops upstream traffic', async () => {
  const poller = createPoller(db, testConfig({ POLLING_ENABLED: 'false' }), async () => []);
  assert.equal(await poller.canPoll(), false);
});

test('the scheduler only checks watched courses and never double-queues', async () => {
  const userId = await seedUser(db, 'a@asu.edu');
  const watched = await seedCourse(db, 'CSE', '310');
  await seedCourse(db, 'CSE', '320');
  await seedWatch(db, userId, watched, null);
  const slow = testConfig({ POLL_MIN_SPACING_MS: '100' });
  assert.equal(await scheduleDuePolls(db, slow, 5000), 1);
  assert.equal(await scheduleDuePolls(db, slow, 5000), 0);
  await db.query('UPDATE courses SET next_poll_at = now()');
  assert.equal(await scheduleDuePolls(db, slow, 5000), 1, 'course is reserved');
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'poll_course' AND status = 'queued'`);
  assert.equal(rows[0]!.n, 1);
});

test('the revisit interval stretches so request rate stays capped', async () => {
  const userId = await seedUser(db, 'a@asu.edu');
  for (let i = 0; i < 60; i += 1) await seedWatch(db, userId, await seedCourse(db, 'CSE', String(100 + i)), null);
  const spaced = testConfig({ POLL_MIN_SPACING_MS: '2000', POLL_INTERVAL_MS: '60000' });
  const batch = await scheduleDuePolls(db, spaced, 5000);
  assert.equal(batch, 3, 'never schedules more than the spacing allows per tick');
  const { rows } = await db.query<{ secs: number }>(
    `SELECT EXTRACT(EPOCH FROM max(next_poll_at) - now())::float8 AS secs FROM courses`,
  );
  assert.ok(rows[0]!.secs > 115 && rows[0]!.secs <= 120, `60 courses at 2s spacing is a 120s cycle, got ${rows[0]!.secs}`);
});

async function openOne(): Promise<number> {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await applySnapshot(db, config, courseId, [section('100', 28)]);
  const { rows } = await db.query<{ id: number }>('SELECT id FROM notifications LIMIT 1');
  return rows[0]!.id;
}

test('delivery sends once with an idempotency key and stop link', async () => {
  const id = await openOne();
  const senders = fakeSenders();
  await deliverNotification(db, config, senders, id);
  await deliverNotification(db, config, senders, id);
  assert.equal(senders.emails.length, 1);
  const email = senders.emails[0]!;
  assert.equal(email.idempotencyKey, `notification-${id}`);
  assert.match(email.subject, /CSE 310/);
  assert.match(email.text, /Class number: 100/);
  assert.match(email.headers!['List-Unsubscribe']!, /\/u\/token-/);
  const { rows } = await db.query('SELECT status FROM notifications WHERE id = $1', [id]);
  assert.equal(rows[0]!.status, 'sent');
});

test('a transient send failure throws so the queue retries, and leaves it queued', async () => {
  const id = await openOne();
  const senders = fakeSenders();
  senders.email = async () => { throw new Error('provider 500'); };
  await assert.rejects(deliverNotification(db, config, senders, id));
  const { rows } = await db.query('SELECT status FROM notifications WHERE id = $1', [id]);
  assert.equal(rows[0]!.status, 'queued');
});

test('stale alerts expire instead of arriving late', async () => {
  const id = await openOne();
  await db.query(`UPDATE seat_openings SET opened_at = now() - interval '45 minutes'`);
  const senders = fakeSenders();
  await deliverNotification(db, config, senders, id);
  assert.equal(senders.emails.length, 0);
  const { rows } = await db.query('SELECT status FROM notifications WHERE id = $1', [id]);
  assert.equal(rows[0]!.status, 'expired');
});

test('a stopped alert is not delivered even if already queued', async () => {
  const id = await openOne();
  await db.query('UPDATE watches SET active = false');
  const senders = fakeSenders();
  await deliverNotification(db, config, senders, id);
  assert.equal(senders.emails.length, 0);
});

test('the daily email budget protects the quota sign-in codes need', async () => {
  const id = await openOne();
  await db.query(`INSERT INTO daily_counters (day, name, value) VALUES ((now() AT TIME ZONE 'America/Phoenix')::date, 'alerts_email', 80)`);
  const senders = fakeSenders();
  await deliverNotification(db, testConfig({ EMAIL_ALERT_DAILY_BUDGET: '80' }), senders, id);
  assert.equal(senders.emails.length, 0);
  const { rows } = await db.query('SELECT status, error FROM notifications WHERE id = $1', [id]);
  assert.deepEqual(rows[0], { status: 'failed', error: 'daily email budget reached' });
});

test('a dead push subscription is removed', async () => {
  const { courseId, a, userId } = await setup();
  await seedWatch(db, userId, courseId, a);
  await db.query('UPDATE users SET email_enabled = false');
  await db.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://push.test/1', 'x', 'y')`, [userId]);
  await applySnapshot(db, config, courseId, [section('100', 28)]);
  const job = (await claim(db, ['send_notification'], 'w', 1000))!;
  const senders = fakeSenders();
  senders.push = async () => { throw new SubscriptionGoneError('410'); };
  await deliverNotification(db, config, senders, (job.payload as { notificationId: number }).notificationId);
  await complete(db, job, 'w');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM push_subscriptions');
  assert.equal(rows[0]!.n, 0);
});
