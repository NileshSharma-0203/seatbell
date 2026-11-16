import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Db } from '../src/db.ts';
import { claim, complete, enqueue, fail, reapExpired } from '../src/queue.ts';
import { freshDb } from './helpers.ts';

let db: Db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.query('TRUNCATE jobs'); });

test('concurrent workers never claim the same job', async () => {
  const total = 200;
  for (let i = 0; i < total; i += 1) await enqueue(db, 'k', { i });
  const claimed: string[] = [];
  await Promise.all(Array.from({ length: 16 }, async (_, w) => {
    for (;;) {
      const job = await claim(db, ['k'], `w${w}`, 60_000);
      if (!job) return;
      claimed.push(job.id);
      await complete(db, job, `w${w}`);
    }
  }));
  assert.equal(claimed.length, total);
  assert.equal(new Set(claimed).size, total);
});

test('dedupe blocks while active and allows again after completion', async () => {
  assert.equal(await enqueue(db, 'k', {}, { dedupeKey: 'a' }), true);
  assert.equal(await enqueue(db, 'k', {}, { dedupeKey: 'a' }), false);
  const job = (await claim(db, ['k'], 'w', 60_000))!;
  assert.equal(await enqueue(db, 'k', {}, { dedupeKey: 'a' }), false);
  await complete(db, job, 'w');
  assert.equal(await enqueue(db, 'k', {}, { dedupeKey: 'a' }), true);
});

test('higher priority runs first, delayed jobs wait', async () => {
  await enqueue(db, 'k', { n: 'low' });
  await enqueue(db, 'k', { n: 'high' }, { priority: 5 });
  await enqueue(db, 'k', { n: 'later' }, { priority: 9, delayMs: 60_000 });
  assert.deepEqual((await claim(db, ['k'], 'w', 1000))!.payload, { n: 'high' });
  assert.deepEqual((await claim(db, ['k'], 'w', 1000))!.payload, { n: 'low' });
  assert.equal(await claim(db, ['k'], 'w', 1000), null);
});

test('a job enqueued in a rolled-back transaction never exists', async () => {
  await assert.rejects(db.tx(async (tx) => {
    await enqueue(tx, 'k', {});
    throw new Error('boom');
  }));
  assert.equal(await claim(db, ['k'], 'w', 1000), null);
});

test('failures retry, then dead-letter', async () => {
  await enqueue(db, 'k', {}, { maxAttempts: 2 });
  const first = (await claim(db, ['k'], 'w', 1000))!;
  assert.equal(await fail(db, first, 'w', 'oops'), 'retry');
  assert.equal(await claim(db, ['k'], 'w', 1000), null, 'backoff delays the retry');
  await db.query('UPDATE jobs SET run_at = now()');
  const second = (await claim(db, ['k'], 'w', 1000))!;
  assert.equal(second.attempts, 2);
  assert.equal(await fail(db, second, 'w', 'oops'), 'dead');
  const { rows } = await db.query('SELECT status, last_error FROM jobs');
  assert.deepEqual(rows[0], { status: 'dead', last_error: 'oops' });
});

test('a crashed worker\'s job is reclaimed, and the zombie cannot finish it', async () => {
  await enqueue(db, 'k', {});
  const zombie = (await claim(db, ['k'], 'zombie', 1000))!;
  await db.query(`UPDATE jobs SET locked_until = now() - interval '1 second'`);
  assert.deepEqual(await reapExpired(db), { requeued: 1, dead: 0 });
  const owner = (await claim(db, ['k'], 'owner', 60_000))!;
  assert.equal(owner.id, zombie.id);
  assert.equal(await complete(db, zombie, 'zombie'), false);
  assert.equal(await fail(db, zombie, 'zombie', 'late'), 'lost');
  assert.equal(await complete(db, owner, 'owner'), true);
});

test('a job that keeps crashing workers is dead-lettered', async () => {
  await enqueue(db, 'k', {}, { maxAttempts: 1 });
  await claim(db, ['k'], 'w', 1000);
  await db.query(`UPDATE jobs SET locked_until = now() - interval '1 second'`);
  assert.deepEqual(await reapExpired(db), { requeued: 0, dead: 1 });
});
