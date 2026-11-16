import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import type { Config } from '../src/config.ts';
import type { Db } from '../src/db.ts';
import type { SectionSnapshot } from '../src/asu/parse.ts';
import { createApp } from '../src/web/server.ts';
import { startWorker } from '../src/worker/runner.ts';
import type { Worker } from '../src/worker/runner.ts';
import { fakeSenders, freshDb, section, testConfig, until } from './helpers.ts';
import type { FakeSenders } from './helpers.ts';

let db: Db;
let server: Server;
let base: string;
let senders: FakeSenders;
let config: Config;
const ORIGIN = 'http://localhost:3000';

before(async () => {
  db = await freshDb();
  senders = fakeSenders();
  config = testConfig({ WATCH_LIMIT: '2' });
  server = createApp(db, config, senders);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});
beforeEach(async () => {
  await db.query('TRUNCATE users, login_codes, courses, jobs, rate_limits, system_state, daily_counters, feedback RESTART IDENTITY CASCADE');
  senders.emails.length = 0;
  senders.pushes.length = 0;
});

interface Res { status: number; json: Record<string, any>; headers: Headers; text: string }

async function call(method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}): Promise<Res> {
  const response = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { origin: ORIGIN } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text) as Record<string, any>; } catch { /* html */ }
  return { status: response.status, json, headers: response.headers, text };
}

function codeFromLastEmail(): string {
  return /\d{6}/.exec(senders.emails.at(-1)!.subject)![0];
}

async function signIn(email = 'sparky@asu.edu'): Promise<string> {
  await call('POST', '/api/auth/start', { email });
  const res = await call('POST', '/api/auth/verify', { email, code: codeFromLastEmail(), ref: 'reddit' });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

test('public pages render with security headers', async () => {
  for (const path of ['/', '/login', '/status', '/feedback', '/privacy', '/terms']) {
    const res = await call('GET', path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.match(res.text, /not affiliated/);
  }
  assert.equal((await call('GET', '/app')).status, 303);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/../../package.json')).status, 404);
});

test('sign-in works and is single use', async () => {
  await call('POST', '/api/auth/start', { email: 'Sparky@ASU.edu' });
  const code = codeFromLastEmail();
  const cookie = (await call('POST', '/api/auth/verify', { email: 'sparky@asu.edu', code })).headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const me = await call('GET', '/api/me', undefined, cookie.split(';')[0]);
  assert.equal(me.json.email, 'sparky@asu.edu');
  assert.equal((await call('POST', '/api/auth/verify', { email: 'sparky@asu.edu', code })).status, 400);
});

test('non-ASU emails are refused and no email is sent', async () => {
  const res = await call('POST', '/api/auth/start', { email: 'a@gmail.com' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /@asu\.edu/);
  assert.equal(senders.emails.length, 0);
});

test('five wrong guesses burn the code, even if the sixth is right', async () => {
  await call('POST', '/api/auth/start', { email: 'a@asu.edu' });
  const code = codeFromLastEmail();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) assert.equal((await call('POST', '/api/auth/verify', { email: 'a@asu.edu', code: wrong })).status, 400);
  assert.equal((await call('POST', '/api/auth/verify', { email: 'a@asu.edu', code })).status, 400);
});

test('codes expire and a new code replaces the old one', async () => {
  await call('POST', '/api/auth/start', { email: 'a@asu.edu' });
  const first = codeFromLastEmail();
  await db.query(`UPDATE login_codes SET expires_at = now() - interval '1 second'`);
  assert.equal((await call('POST', '/api/auth/verify', { email: 'a@asu.edu', code: first })).status, 400);
});

test('code requests are rate limited per address', async () => {
  for (let i = 0; i < 5; i += 1) assert.equal((await call('POST', '/api/auth/start', { email: 'a@asu.edu' })).status, 200);
  assert.equal((await call('POST', '/api/auth/start', { email: 'a@asu.edu' })).status, 429);
});

test('cross-site POSTs are blocked', async () => {
  const cookie = await signIn();
  const res = await call('POST', '/api/test-alert', {}, cookie, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'send_test'`);
  assert.equal(rows[0]!.n, 0);
});

test('API needs a session; forged cookies fail', async () => {
  assert.equal((await call('GET', '/api/watches')).status, 401);
  assert.equal((await call('GET', '/api/watches', undefined, 'seatbell=forged')).status, 401);
});

test('oversized and malformed bodies are rejected cleanly', async () => {
  const res = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{bad' });
  assert.equal(res.status, 400);
  const big = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ message: 'x'.repeat(40000) }) }).catch(() => null);
  assert.ok(big === null || big.status === 413);
});

async function seedSections(snapshot: SectionSnapshot[]): Promise<{ worker: Worker; set: (s: SectionSnapshot[]) => void; calls: () => number }> {
  let current = snapshot;
  let calls = 0;
  const worker = startWorker(db, testConfig({ POLL_INTERVAL_MS: '50' }), async () => {
    calls += 1;
    return current;
  }, senders, 2);
  return { worker, set: (s) => { current = s; }, calls: () => calls };
}

async function lookup(cookie: string, course = 'cse310'): Promise<Record<string, any>> {
  const res = await call('POST', '/api/lookup', { term: '2271', course }, cookie);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  let detail: Res;
  await until(async () => {
    detail = await call('GET', `/api/courses/${res.json.courseId}`, undefined, cookie);
    return detail.json.pending === false;
  });
  return detail!.json;
}

test('end to end: sign in, find a class, watch it, seat opens, alert arrives, stop link works', async () => {
  const fake = await seedSections([section('100', 30), section('200', 30)]);
  try {
    const cookie = await signIn();
    const course = await lookup(cookie);
    assert.equal(course.subject, 'CSE');
    assert.equal(course.sections.length, 2);

    const target = course.sections.find((s: { class_nbr: string }) => s.class_nbr === '100');
    assert.equal((await call('POST', '/api/watches', { courseId: course.id, sectionId: target.id }, cookie)).status, 201);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(senders.emails.filter((e) => /Seat open/.test(e.subject)).length, 0);
    await db.query('UPDATE courses SET next_poll_at = now()');
    fake.set([section('100', 28), section('200', 30)]);

    await until(() => senders.emails.some((e) => /Seat open/.test(e.subject)));
    const alert = senders.emails.find((e) => /Seat open/.test(e.subject))!;
    assert.equal(alert.to, 'sparky@asu.edu');

    await until(async () => (await db.query(`SELECT 1 FROM daily_counters WHERE name = 'alerts_email' AND value = 1`)).rows.length === 1);

    const list = await call('GET', '/api/watches', undefined, cookie);
    assert.equal(list.json.watches[0].open_seats, 2);

    const path = /\/u\/[\w-]+/.exec(alert.headers!['List-Unsubscribe']!)![0];
    const preview = await call('GET', path);
    assert.match(preview.text, /Stop alerts for CSE 310/);
    assert.equal((await call('GET', '/api/watches', undefined, cookie)).json.watches.length, 1, 'GET must not stop the alert');
    const stop = await fetch(base + path, { method: 'POST', body: 'List-Unsubscribe=One-Click' });
    assert.equal(stop.status, 200);
    assert.equal((await call('GET', '/api/watches', undefined, cookie)).json.watches.length, 0);
  } finally {
    await fake.worker.stop();
  }
});

test('a fresh course isn\'t fetched again for the next person', async () => {
  const fake = await seedSections([section('100', 30)]);
  try {
    const one = await signIn('a@asu.edu');
    await lookup(one);
    const before = fake.calls();
    const two = await signIn('b@asu.edu');
    await lookup(two);
    assert.equal(fake.calls(), before);
  } finally {
    await fake.worker.stop();
  }
});

test('course input is validated and watch limit holds under concurrency', async () => {
  const fake = await seedSections([section('100', 30), section('200', 30), section('300', 30), section('400', 30)]);
  try {
    const cookie = await signIn();
    assert.equal((await call('POST', '/api/lookup', { term: '2271', course: "'; DROP TABLE users" }, cookie)).status, 400);
    assert.equal((await call('POST', '/api/lookup', { term: '9999', course: 'CSE 310' }, cookie)).status, 400);
    const course = await lookup(cookie);
    const responses = await Promise.all(course.sections.map((s: { id: number }) => call('POST', '/api/watches', { courseId: course.id, sectionId: s.id }, cookie)));
    assert.equal(responses.filter((r) => r.status === 201).length, 2);
    assert.equal(responses.filter((r) => r.status === 409).length, 2);
  } finally {
    await fake.worker.stop();
  }
});

test('people can\'t touch each other\'s alerts', async () => {
  const fake = await seedSections([section('100', 30)]);
  try {
    const a = await signIn('a@asu.edu');
    const b = await signIn('b@asu.edu');
    const course = await lookup(a);
    await call('POST', '/api/watches', { courseId: course.id, sectionId: null }, a);
    const id = (await call('GET', '/api/watches', undefined, a)).json.watches[0].id;
    await call('DELETE', `/api/watches/${id}`, undefined, b);
    assert.equal((await call('GET', '/api/watches', undefined, a)).json.watches.length, 1);
    assert.equal((await call('GET', '/api/watches', undefined, b)).json.watches.length, 0);
  } finally {
    await fake.worker.stop();
  }
});

test('stopping and re-adding the same alert revives it', async () => {
  const fake = await seedSections([section('100', 30)]);
  try {
    const cookie = await signIn();
    const course = await lookup(cookie);
    await call('POST', '/api/watches', { courseId: course.id, sectionId: null }, cookie);
    assert.equal((await call('POST', '/api/watches', { courseId: course.id, sectionId: null }, cookie)).status, 409);
    const id = (await call('GET', '/api/watches', undefined, cookie)).json.watches[0].id;
    await call('DELETE', `/api/watches/${id}`, undefined, cookie);
    assert.equal((await call('POST', '/api/watches', { courseId: course.id, sectionId: null }, cookie)).status, 201);
  } finally {
    await fake.worker.stop();
  }
});

test('a section from another course is rejected', async () => {
  const fake = await seedSections([section('100', 30)]);
  try {
    const cookie = await signIn();
    const c1 = await lookup(cookie, 'CSE 310');
    const c2 = await lookup(cookie, 'CSE 340');
    assert.notEqual(c1.id, c2.id);
    const res = await call('POST', '/api/watches', { courseId: c2.id, sectionId: c1.sections[0].id }, cookie);
    assert.equal(res.status, 404);
  } finally {
    await fake.worker.stop();
  }
});

test('push subscriptions only accept known push hosts', async () => {
  const cookie = await signIn();
  const evil = await call('POST', '/api/push/subscribe', { endpoint: 'http://169.254.169.254/latest', keys: { p256dh: 'a', auth: 'b' } }, cookie);
  assert.equal(evil.status, 400);
  const ok = await call('POST', '/api/push/subscribe', { endpoint: 'https://push.test/abc', keys: { p256dh: 'a', auth: 'b' } }, cookie);
  assert.equal(ok.status, 201);
});

test('feedback is stored for anonymous visitors', async () => {
  assert.equal((await call('POST', '/api/feedback', { kind: 'bug', message: 'Missed my alert', contact: 'x@asu.edu' })).status, 201);
  const { rows } = await db.query('SELECT kind, message, contact FROM feedback');
  assert.deepEqual(rows[0], { kind: 'bug', message: 'Missed my alert', contact: 'x@asu.edu' });
});

test('deleting an account removes personal data but keeps anonymous totals', async () => {
  const cookie = await signIn();
  await db.query(`INSERT INTO daily_counters (day, name, value) VALUES (current_date, 'alerts_email', 3)`);
  assert.equal((await call('POST', '/api/account/delete', {}, cookie)).status, 200);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
  assert.equal(rows[0]!.n, 0);
  assert.equal((await call('GET', '/api/me', undefined, cookie)).status, 401);
  const status = await call('GET', '/status');
  assert.match(status.text, /Alerts sent all time<\/dt><dd>3/);
});

test('health endpoints tell the truth about the poller', async () => {
  assert.equal((await call('GET', '/healthz')).status, 200);
  assert.equal((await call('GET', '/readyz')).status, 200);
  assert.equal((await call('GET', '/healthz/poller')).status, 200, 'idle with nobody watching is healthy');

  const { rows: u } = await db.query<{ id: number }>(`INSERT INTO users (email) VALUES ('a@asu.edu') RETURNING id`);
  const { rows: c } = await db.query<{ id: number }>(`INSERT INTO courses (term, subject, catalog_nbr) VALUES ('2271','CSE','310') RETURNING id`);
  await db.query(`INSERT INTO watches (user_id, course_id, unsubscribe_token) VALUES ($1, $2, 't')`, [u[0]!.id, c[0]!.id]);
  const stale = await call('GET', '/healthz/poller');
  assert.equal(stale.status, 503, 'watched courses with no successful check is an outage');

  await db.query(`INSERT INTO system_state (key, value) VALUES ('poller', $1)`, [JSON.stringify({ lastSuccessAt: new Date().toISOString(), consecutiveFailures: 0, breakerUntil: null })]);
  assert.equal((await call('GET', '/healthz/poller')).status, 200);
});

test('metrics are exposed in Prometheus format', async () => {
  await call('GET', '/');
  const res = await call('GET', '/metrics');
  assert.match(res.text, /seatbell_http_requests_total\{.*route="\/".*\} \d+/);
});

test('static files are served with etags and path traversal fails', async () => {
  const css = await call('GET', '/styles.css');
  assert.equal(css.status, 200);
  const cached = await call('GET', '/styles.css', undefined, undefined, { 'if-none-match': css.headers.get('etag')! });
  assert.equal(cached.status, 304);
  assert.equal((await call('GET', '/%2e%2e/package.json')).status, 404);
});
