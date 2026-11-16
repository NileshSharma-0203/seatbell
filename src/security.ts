import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const newToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const hashToken = (secret: string, token: string): string =>
  createHmac('sha256', secret).update(token).digest('base64url');

export const newLoginCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function emailDomainAllowed(email: string, domains: string[]): boolean {
  const domain = email.split('@')[1] ?? '';
  return domains.length === 0 || domains.includes(domain);
}

export function hostAllowed(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern,
  );
}
