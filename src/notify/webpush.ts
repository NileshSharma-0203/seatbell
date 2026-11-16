// Web Push with message encryption (RFC 8291) and VAPID (RFC 8292), on node:crypto.
import { createECDH, createPrivateKey, hkdfSync, randomBytes, sign, createCipheriv } from 'node:crypto';

const b64u = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString('base64url');
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length));

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function encryptPayload(target: PushTarget, plaintext: Buffer): Buffer {
  const uaPublic = Buffer.from(target.p256dh, 'base64url');
  const authSecret = Buffer.from(target.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);

  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body]);
}

export function vapidHeader(endpoint: string, keys: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 3600,
    sub: keys.subject,
  })));
  const publicKey = Buffer.from(keys.publicKey, 'base64url');
  const key = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64u(publicKey.subarray(1, 33)),
      y: b64u(publicKey.subarray(33, 65)),
    },
  });
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}
