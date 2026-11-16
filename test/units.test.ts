import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ContractError, parseClassSearch } from '../src/asu/parse.ts';
import { findConflicts, parseMinutes } from '../src/web/schedule.ts';
import { encryptPayload, generateVapidKeys, vapidHeader } from '../src/notify/webpush.ts';
import { emailDomainAllowed, hostAllowed, normalizeEmail } from '../src/security.ts';
import { backoffMs } from '../src/queue.ts';
import { loadConfig } from '../src/config.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/class-search.json', import.meta.url), 'utf8')) as { classes: unknown[] };

test('parses seats from strings and numbers and dedupes instructors', () => {
  const [full, open] = parseClassSearch(fixture);
  assert.equal(full!.classNbr, '12345');
  assert.equal(full!.openSeats, 0);
  assert.equal(full!.instructors, 'Ada Lovelace');
  assert.equal(open!.openSeats, 2);
  assert.equal(open!.capacity, 80);
});

test('over-enrolled sections count as zero seats', () => {
  const [s] = parseClassSearch({ classes: [{ CLAS: { CLASSNBR: '1' }, seatInfo: { ENRL_CAP: 10, ENRL_TOT: 12 } }] });
  assert.equal(s!.openSeats, 0);
});

test('an empty class list is valid', () => assert.deepEqual(parseClassSearch({ classes: [] }), []));

test('rejects a response without a classes array', () => {
  assert.throws(() => parseClassSearch({ error: 'nope' }), ContractError);
  assert.throws(() => parseClassSearch(null), ContractError);
});

test('one unreadable record rejects the whole snapshot', () => {
  const body = { classes: [...fixture.classes, { CLAS: { CLASSNBR: '9' }, seatInfo: {} }] };
  assert.throws(() => parseClassSearch(body), ContractError);
});

test('web push payload decrypts with the RFC 8291 receiver steps', () => {
  const receiver = createECDH('prime256v1');
  const uaPublic = receiver.generateKeys();
  const auth = randomBytes(16);
  const message = Buffer.from('{"title":"seat"}');
  const out = encryptPayload({ endpoint: 'https://push.test/x', p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') }, message);

  const salt = out.subarray(0, 16);
  assert.equal(out.readUInt32BE(16), 4096);
  const idLength = out[20]!;
  assert.equal(idLength, 65);
  const asPublic = out.subarray(21, 21 + idLength);
  const body = out.subarray(21 + idLength);

  const shared = receiver.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2);
  assert.deepEqual(plain.subarray(0, -1), message);
});

test('VAPID header has a valid ES256 signature and the endpoint origin as audience', () => {
  const keys = generateVapidKeys();
  const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'mailto:a@b.co' });
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  const claims = JSON.parse(Buffer.from(match[2]!, 'base64url').toString()) as { aud: string; exp: number };
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp - Date.now() / 1000 <= 24 * 3600);
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33, 65).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${match[1]}.${match[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(match[3]!, 'base64url')));
});

test('time parsing', () => {
  assert.equal(parseMinutes('10:30 AM'), 630);
  assert.equal(parseMinutes('12:00 PM'), 720);
  assert.equal(parseMinutes('12:15 AM'), 15);
  assert.equal(parseMinutes('1:05 PM'), 785);
  assert.equal(parseMinutes('1330'), 810);
  assert.equal(parseMinutes('TBA'), null);
});

test('conflicts need a shared day and overlapping time in the same term', () => {
  const m = (id: number, days: string, startTime: string, endTime: string, term = '2271') => ({ id, label: `C${id}`, term, days, startTime, endTime });
  const conflicts = findConflicts([
    m(1, 'T Th', '10:30 AM', '11:45 AM'),
    m(2, 'Th', '11:00 AM', '12:00 PM'),
    m(3, 'MWF', '10:30 AM', '11:45 AM'),
    m(4, 'T', '11:45 AM', '1:00 PM'),
    m(5, 'T', '10:30 AM', '11:00 AM', '2277'),
  ]);
  assert.deepEqual(conflicts.get(1), ['C2']);
  assert.deepEqual(conflicts.get(2), ['C1']);
  assert.equal(conflicts.has(3), false);
  assert.equal(conflicts.has(4), false);
});

test('alternative sections of the same course are not a conflict', () => {
  const s = (id: number) => ({ id, label: 'CSE 310', term: 't', days: 'T', startTime: '9:00 AM', endTime: '10:00 AM' });
  assert.equal(findConflicts([s(1), s(2)]).size, 0);
});

test('Tuesday and Thursday are told apart', () => {
  const a = { id: 1, label: 'A', term: 't', days: 'T', startTime: '9:00 AM', endTime: '10:00 AM' };
  const b = { id: 2, label: 'B', term: 't', days: 'Th', startTime: '9:00 AM', endTime: '10:00 AM' };
  assert.equal(findConflicts([a, b]).size, 0);
});

test('email and host checks', () => {
  assert.equal(normalizeEmail('  Sparky@ASU.edu '), 'sparky@asu.edu');
  assert.equal(normalizeEmail('nope'), null);
  assert.equal(emailDomainAllowed('a@asu.edu', ['asu.edu']), true);
  assert.equal(emailDomainAllowed('a@asu.edu.evil.com', ['asu.edu']), false);
  assert.equal(hostAllowed('web.push.apple.com', ['*.push.apple.com']), true);
  assert.equal(hostAllowed('evilpush.apple.com', ['*.push.apple.com']), false);
  assert.equal(hostAllowed('169.254.169.254', ['fcm.googleapis.com', '*.push.apple.com']), false);
});

test('backoff grows and stays capped', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.ok(backoffMs(1) <= 2000);
    assert.ok(backoffMs(20) <= 300_000);
    assert.ok(backoffMs(20) >= 150_000);
  }
});

test('production refuses to start with weak or missing settings', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Missing required/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production', BASE_URL: 'https://x.co', DATABASE_URL: 'x', SESSION_SECRET: 'short',
  }), /at least 32/);
});
