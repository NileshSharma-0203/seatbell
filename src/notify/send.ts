import type { Config } from '../config.ts';
import { log } from '../log.ts';
import { hostAllowed } from '../security.ts';
import { encryptPayload, vapidHeader } from './webpush.ts';
import type { PushTarget } from './webpush.ts';

/** The provider said this will never succeed; retrying is pointless. */
export class PermanentDeliveryError extends Error {}
/** The push subscription no longer exists and should be removed. */
export class SubscriptionGoneError extends PermanentDeliveryError {}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface Senders {
  email(message: EmailMessage): Promise<string | null>;
  push(target: PushTarget, message: PushMessage): Promise<string | null>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export function createSenders(config: Config): Senders {
  return {
    async email(message) {
      if (config.email.provider === 'log') {
        log.info('email (not sent, log provider)', { to: message.to, subject: message.subject, text: message.text });
        return null;
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${config.email.apiKey}`,
        'content-type': 'application/json',
      };
      if (message.idempotencyKey) headers['idempotency-key'] = message.idempotencyKey;
      const response = await fetch(`${config.email.apiBase}/emails`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: config.email.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: message.headers,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const detail = await response.text();
      if (response.ok) return (JSON.parse(detail) as { id?: string }).id ?? null;
      const error = `email provider returned ${response.status}: ${detail.slice(0, 300)}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 409) {
        throw new PermanentDeliveryError(error);
      }
      throw new Error(error);
    },

    async push(target, message) {
      if (!config.push.publicKey || !config.push.privateKey) {
        throw new PermanentDeliveryError('web push is not configured');
      }
      const url = new URL(target.endpoint);
      if (!(url.protocol === 'https:' || config.env !== 'production') || !hostAllowed(url.hostname, config.push.allowedHosts)) {
        throw new SubscriptionGoneError(`push host not allowed: ${url.hostname}`);
      }
      const response = await fetch(target.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidHeader(target.endpoint, {
            publicKey: config.push.publicKey,
            privateKey: config.push.privateKey,
            subject: config.push.subject,
          }),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: '1800',
          urgency: 'high',
          topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
        },
        body: new Uint8Array(encryptPayload(target, Buffer.from(JSON.stringify(message)))),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const detail = await response.text();
      if (response.ok) return response.headers.get('location');
      const error = `push service returned ${response.status}: ${detail.slice(0, 300)}`;
      if (response.status === 404 || response.status === 410) throw new SubscriptionGoneError(error);
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new PermanentDeliveryError(error);
      }
      throw new Error(error);
    },
  };
}
