import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.ts';
import { bumpCounter, markActive } from '../db.ts';
import type { Db, Queryable } from '../db.ts';
import { errorMessage, log } from '../log.ts';
import { metrics, renderMetrics } from '../metrics.ts';
import { enqueue } from '../queue.ts';
import { emailDomainAllowed, hashToken, hostAllowed, newLoginCode, newToken, normalizeEmail, safeEqual } from '../security.ts';
import type { Senders } from '../notify/send.ts';
import { loginEmail } from '../notify/templates.ts';
import { breakerIsOpen, readPollerState } from '../worker/poll.ts';
import * as pages from './pages.ts';
import { findConflicts } from './schedule.ts';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const SESSION_DAYS = 30;
const MAX_BODY = 16 * 1024;
const LOGIN_CODE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface User {
  id: number;
  email: string;
  email_enabled: boolean;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  user: User | null;
  ip: string;
  body: () => Promise<Record<string, unknown>>;
}

type Handler = (ctx: Ctx) => Promise<void> | void;
interface Route {
  method: string;
  pattern: RegExp;
  label: string;
  handler: Handler;
  csrfExempt?: boolean;
}

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function loadStatic(): Map<string, { body: Buffer; type: string; etag: string }> {
  const files = new Map<string, { body: Buffer; type: string; etag: string }>();
  for (const name of readdirSync(PUBLIC_DIR)) {
    const body = readFileSync(path.join(PUBLIC_DIR, name));
    files.set(`/${name}`, {
      body,
      type: MIME[path.extname(name)] ?? 'application/octet-stream',
      etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`,
    });
  }
  return files;
}

function clientIp(req: IncomingMessage): string {
  // Caddy appends the real peer last; anything earlier is client-supplied.
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  return value?.split(',').pop()?.trim() || req.socket.remoteAddress || 'unknown';
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value));
};

const sendHtml = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
};

async function underLimit(db: Queryable, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::int) * $2::int), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowSeconds],
  );
  return (rows[0]?.count ?? 0) <= limit;
}

function ago(iso: string | null): string {
  if (!iso) return 'Not yet';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return seconds === 1 ? '1 second ago' : `${seconds} seconds ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes ago`;
  return `${Math.round(seconds / 3600)} hours ago`;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(db: Db, config: Config, senders: Senders): Server {
  const secure = config.baseUrl.startsWith('https://');
  const cookieName = secure ? '__Host-seatbell' : 'seatbell';
  const origin = new URL(config.baseUrl).origin;
  const staticFiles = loadStatic();
  const termCodes = new Set(config.terms.map((t) => t.code));
  const activeToday = new Set<string>();
  let activeDay = '';

  function sessionCookie(token: string, maxAgeSeconds: number): string {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  }

  async function loadUser(req: IncomingMessage): Promise<User | null> {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (!token) return null;
    const { rows } = await db.query<User>(
      `SELECT u.id, u.email, u.email_enabled FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(config.sessionSecret, token)],
    );
    return rows[0] ?? null;
  }

  async function noteActivity(userId: number): Promise<void> {
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
    if (day !== activeDay) {
      activeDay = day;
      activeToday.clear();
    }
    if (activeToday.has(`${userId}`)) return;
    activeToday.add(`${userId}`);
    await markActive(db, userId);
  }

  const requireUser = (ctx: Ctx): User => {
    if (!ctx.user) throw new HttpError(401, 'Sign in to continue.');
    return ctx.user;
  };

  const refOf = (url: URL): string | null => {
    const ref = url.searchParams.get('ref')?.toLowerCase() ?? '';
    return /^[a-z0-9_-]{1,24}$/.test(ref) ? ref : null;
  };

  const intParam = (value: string | undefined): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) throw new HttpError(404, 'Not found.');
    return parsed;
  };

  async function statusView(): Promise<pages.StatusView> {
    const state = await readPollerState(db);
    const { rows } = await db.query<{ courses: number; watches: number; alerts: string; ok: string; failed: string }>(
      `SELECT (SELECT count(DISTINCT course_id)::int FROM watches WHERE active) AS courses,
              (SELECT count(*)::int FROM watches WHERE active) AS watches,
              (SELECT COALESCE(sum(value), 0) FROM daily_counters WHERE name LIKE 'alerts_%') AS alerts,
              (SELECT COALESCE(sum(value), 0) FROM daily_counters WHERE name = 'polls_ok' AND day >= current_date - 1) AS ok,
              (SELECT COALESCE(sum(value), 0) FROM daily_counters WHERE name = 'polls_failed' AND day >= current_date - 1) AS failed`,
    );
    const r = rows[0]!;
    const stale = !state.lastSuccessAt || Date.now() - Date.parse(state.lastSuccessAt) > config.polling.staleAfterMs;
    let view: pages.StatusView['state'] = 'ok';
    if (r.courses === 0) view = 'idle';
    else if (!config.polling.enabled || breakerIsOpen(state)) view = 'paused';
    else if (stale) view = 'degraded';
    return {
      state: view,
      lastCheck: ago(state.lastSuccessAt),
      courses: r.courses,
      watches: r.watches,
      alerts: Number(r.alerts),
      checks24h: Number(r.ok),
      failures24h: Number(r.failed),
    };
  }

  const route = (method: string, pattern: string, handler: Handler, opts: { csrfExempt?: boolean } = {}): Route => ({
    method,
    pattern: new RegExp(`^${pattern}$`),
    label: pattern.replace(/\(\[\^\/\]\+\)/g, ':id'),
    handler,
    csrfExempt: opts.csrfExempt,
  });

  const routes: Route[] = [
    route('GET', '/healthz', ({ res }) => void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')),
    route('GET', '/readyz', async ({ res }) => {
      await db.query('SELECT 1');
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ready');
    }),
    route('GET', '/healthz/poller', async ({ res }) => {
      const view = await statusView();
      const healthy = view.state === 'ok' || view.state === 'idle';
      sendJson(res, healthy ? 200 : 503, { state: view.state, lastCheck: view.lastCheck });
    }),
    route('GET', '/metrics', ({ req, res }) => {
      if (config.metricsToken && !safeEqual(req.headers.authorization ?? '', `Bearer ${config.metricsToken}`)) {
        throw new HttpError(401, 'Unauthorized.');
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(renderMetrics());
    }),

    // Pages
    route('GET', '/', async ({ res, url, user }) => {
      const ref = refOf(url);
      await bumpCounter(db, 'view_landing');
      if (ref) await bumpCounter(db, `visit_ref_${ref}`);
      const view = await statusView();
      const live = view.courses >= 5 ? `Checking ${view.courses} courses right now. Last check ${view.lastCheck}.` : null;
      sendHtml(res, 200, pages.landingPage(config, ref, Boolean(user), live));
    }),
    route('GET', '/login', ({ res, url, user }) => {
      if (user) {
        res.writeHead(303, { location: '/app' }).end();
        return;
      }
      sendHtml(res, 200, pages.loginPage(config, refOf(url)));
    }),
    route('GET', '/app', ({ res, user }) => {
      if (!user) {
        res.writeHead(303, { location: '/login' }).end();
        return;
      }
      sendHtml(res, 200, pages.appPage(config));
    }),
    route('GET', '/status', async ({ res, user }) => sendHtml(res, 200, pages.statusPage(config, await statusView(), Boolean(user)))),
    route('GET', '/feedback', ({ res, user }) => sendHtml(res, 200, pages.feedbackPage(config, Boolean(user)))),
    route('GET', '/privacy', ({ res }) => sendHtml(res, 200, pages.legalPage(config, 'privacy'))),
    route('GET', '/terms', ({ res }) => sendHtml(res, 200, pages.legalPage(config, 'terms'))),
    route('GET', '/about', ({ res }) => {
      // Referenced from the crawler User-Agent so ASU IT can identify and reach the operator.
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(
        `${config.appName} is an independent student project that sends class seat alerts.\n` +
        `It makes spaced, rate-limited requests, one per tracked course per cycle, and shares each result across all users.\n` +
        `To ask for changes or for it to stop, write to ${config.contactEmail}. Requests are honored promptly.\n`,
      );
    }),

    // Stop alert: GET shows a button so mail scanners can't trigger it; POST also serves RFC 8058 one-click.
    route('GET', '/u/([^/]+)', async ({ res, params }) => {
      const label = await watchLabel(params[0]!);
      if (!label) throw new HttpError(404, 'Not found.');
      sendHtml(res, 200, pages.unsubscribePage(config, params[0]!, label, false));
    }),
    route('POST', '/u/([^/]+)', async ({ res, params }) => {
      const label = await watchLabel(params[0]!);
      if (!label) throw new HttpError(404, 'Not found.');
      await db.query('UPDATE watches SET active = false WHERE unsubscribe_token = $1', [params[0]]);
      sendHtml(res, 200, pages.unsubscribePage(config, params[0]!, label, true));
    }, { csrfExempt: true }),

    // Auth
    route('POST', '/api/auth/start', async ({ res, body, ip }) => {
      const email = normalizeEmail((await body()).email);
      if (!email) throw new HttpError(400, 'Enter a valid email address.');
      if (!emailDomainAllowed(email, config.allowedEmailDomains)) {
        throw new HttpError(400, `Use your ${config.allowedEmailDomains.map((d) => `@${d}`).join(' or ')} email.`);
      }
      if (!(await underLimit(db, `start-ip:${ip}`, 30, 3600)) || !(await underLimit(db, `start-email:${email}`, 5, 3600))) {
        throw new HttpError(429, 'Too many codes requested. Wait a while, then try again.');
      }
      const code = newLoginCode();
      await db.tx(async (tx) => {
        await tx.query('UPDATE login_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL', [email]);
        await tx.query(
          `INSERT INTO login_codes (email, code_hash, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 minute'))`,
          [email, hashToken(config.sessionSecret, `${email}:${code}`), LOGIN_CODE_MINUTES],
        );
      });
      try {
        await senders.email({ ...loginEmail(config, code), to: email });
      } catch (err) {
        log.error('login email failed', { error: errorMessage(err) });
        throw new HttpError(502, 'The code could not be sent. Try again in a minute.');
      }
      sendJson(res, 200, { ok: true });
    }),

    route('POST', '/api/auth/verify', async ({ res, body, ip }) => {
      const input = await body();
      const email = normalizeEmail(input.email);
      const code = typeof input.code === 'string' ? input.code.trim() : '';
      const source = typeof input.ref === 'string' && /^[a-z0-9_-]{1,24}$/.test(input.ref) ? input.ref : null;
      if (!email || !/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the six-digit code from your email.');
      if (!(await underLimit(db, `verify-ip:${ip}`, 60, 3600))) {
        throw new HttpError(429, 'Too many attempts. Wait a while, then try again.');
      }

      // Returns rather than throws on a wrong code: the attempt count must commit.
      const token = await db.tx(async (tx) => {
        const { rows } = await tx.query<{ id: number; code_hash: string; attempts: number }>(
          `SELECT id, code_hash, attempts FROM login_codes
            WHERE email = $1 AND consumed_at IS NULL AND expires_at > now()
            ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [email],
        );
        const row = rows[0];
        if (!row) return null;
        if (!safeEqual(row.code_hash, hashToken(config.sessionSecret, `${email}:${code}`))) {
          await tx.query(
            `UPDATE login_codes SET attempts = attempts + 1,
                    consumed_at = CASE WHEN attempts + 1 >= $2 THEN now() END WHERE id = $1`,
            [row.id, MAX_CODE_ATTEMPTS],
          );
          return null;
        }
        await tx.query('UPDATE login_codes SET consumed_at = now() WHERE id = $1', [row.id]);
        const { rows: users } = await tx.query<{ id: number }>(
          `INSERT INTO users (email, signup_source) VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
          [email, source],
        );
        const sessionToken = newToken();
        await tx.query(
          `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 day'))`,
          [hashToken(config.sessionSecret, sessionToken), users[0]!.id, SESSION_DAYS],
        );
        return sessionToken;
      });
      if (!token) throw new HttpError(400, 'That code is wrong or expired. Check it, or request a new one.');
      res.setHeader('set-cookie', sessionCookie(token, SESSION_DAYS * 86_400));
      sendJson(res, 200, { ok: true });
    }),

    route('POST', '/api/auth/logout', async ({ req, res }) => {
      const token = parseCookies(req.headers.cookie)[cookieName];
      if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(config.sessionSecret, token)]);
      res.setHeader('set-cookie', sessionCookie('', 0));
      sendJson(res, 200, { ok: true });
    }),

    route('GET', '/api/me', async (ctx) => {
      const user = requireUser(ctx);
      const { rows } = await db.query<{ endpoint: string }>('SELECT endpoint FROM push_subscriptions WHERE user_id = $1', [user.id]);
      sendJson(ctx.res, 200, { email: user.email, emailEnabled: user.email_enabled, pushEndpoints: rows.map((r) => r.endpoint) });
    }),

    // Finding a class. All upstream traffic goes through the worker so its rate limit is global.
    route('POST', '/api/lookup', async (ctx) => {
      const user = requireUser(ctx);
      const input = await ctx.body();
      const match = /^\s*([A-Za-z]{3})\s*-?\s*(\d{3}[A-Za-z]?)\s*$/.exec(String(input.course ?? ''));
      if (!match) throw new HttpError(400, 'Enter a course like CSE 310.');
      if (typeof input.term !== 'string' || !termCodes.has(input.term)) throw new HttpError(400, 'Choose a term.');
      if (!(await underLimit(db, `lookup:${user.id}`, 30, 300))) {
        throw new HttpError(429, 'Too many searches. Wait a few minutes, then try again.');
      }
      const { rows } = await db.query<{ id: number; fresh: boolean }>(
        `INSERT INTO courses (term, subject, catalog_nbr) VALUES ($1, $2, $3)
         ON CONFLICT (term, subject, catalog_nbr) DO UPDATE SET term = EXCLUDED.term
         RETURNING id, COALESCE(last_success_at > now() - interval '60 seconds', false) AS fresh`,
        [input.term, match[1]!.toUpperCase(), match[2]!.toUpperCase()],
      );
      const course = rows[0]!;
      if (!course.fresh) {
        await enqueue(db, 'poll_course', { courseId: course.id }, { dedupeKey: `poll:${course.id}`, priority: 5, maxAttempts: 1 });
      }
      sendJson(ctx.res, 200, { courseId: course.id });
    }),

    route('GET', '/api/courses/([^/]+)', async (ctx) => {
      requireUser(ctx);
      const id = intParam(ctx.params[0]);
      const { rows } = await db.query<{ subject: string; catalog_nbr: string; term: string; title: string | null; last_error: string | null; last_success_at: Date | null; pending: boolean }>(
        `SELECT subject, catalog_nbr, term, title, last_error, last_success_at,
                EXISTS (SELECT 1 FROM jobs WHERE dedupe_key = 'poll:' || courses.id AND status IN ('queued','running')) AS pending
           FROM courses WHERE id = $1`,
        [id],
      );
      const course = rows[0];
      if (!course) throw new HttpError(404, 'Course not found.');
      const { rows: sections } = await db.query(
        `SELECT id, class_nbr, title, instructors, days, start_time, end_time, location, enrolled, capacity, open_seats
           FROM sections WHERE course_id = $1 ORDER BY open_seats DESC, class_nbr`,
        [id],
      );
      sendJson(ctx.res, 200, {
        id,
        subject: course.subject,
        catalogNbr: course.catalog_nbr,
        title: course.title,
        pending: course.pending,
        checked: course.last_success_at !== null,
        unavailable: Boolean(course.last_error) && sections.length === 0,
        sections,
      });
    }),

    // Watches
    route('GET', '/api/watches', async (ctx) => {
      const user = requireUser(ctx);
      const { rows } = await db.query(
        `SELECT w.id, w.section_id, w.last_notified_at, c.term, c.subject, c.catalog_nbr, c.title AS course_title,
                c.last_success_at, s.class_nbr, s.days, s.start_time, s.end_time, s.instructors, s.location,
                CASE WHEN w.section_id IS NULL
                     THEN (SELECT COALESCE(sum(x.open_seats), 0)::int FROM sections x WHERE x.course_id = c.id)
                     ELSE s.open_seats END AS open_seats,
                (SELECT count(*)::int FROM sections x WHERE x.course_id = c.id) AS section_count
           FROM watches w
           JOIN courses c ON c.id = w.course_id
           LEFT JOIN sections s ON s.id = w.section_id
          WHERE w.user_id = $1 AND w.active
          ORDER BY w.created_at DESC`,
        [user.id],
      );
      const conflicts = findConflicts(rows.filter((r) => r.section_id !== null).map((r) => ({
        id: r.id as number,
        label: `${r.subject} ${r.catalog_nbr}`,
        term: r.term as string,
        days: r.days as string | null,
        startTime: r.start_time as string | null,
        endTime: r.end_time as string | null,
      })));
      sendJson(ctx.res, 200, {
        watches: rows.map((r) => ({
          ...r,
          term_label: config.terms.find((t) => t.code === r.term)?.label ?? r.term,
          conflicts: conflicts.get(r.id) ?? [],
        })),
      });
    }),

    route('POST', '/api/watches', async (ctx) => {
      const user = requireUser(ctx);
      const input = await ctx.body();
      const courseId = intParam(String(input.courseId));
      const sectionId = input.sectionId === null || input.sectionId === undefined ? null : intParam(String(input.sectionId));

      const result = await db.tx(async (tx) => {
        // Serializes one user's requests so the limit can't be raced past.
        await tx.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
        const { rows: count } = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM watches WHERE user_id = $1 AND active', [user.id]);
        const { rows: existing } = await tx.query<{ id: number; active: boolean }>(
          'SELECT id, active FROM watches WHERE user_id = $1 AND course_id = $2 AND COALESCE(section_id, 0) = $3',
          [user.id, courseId, sectionId ?? 0],
        );
        if (existing[0]?.active) return 'exists';
        if ((count[0]?.n ?? 0) >= config.watchLimit) return 'limit';
        const { rows: course } = await tx.query('SELECT id FROM courses WHERE id = $1', [courseId]);
        if (!course[0]) return 'missing';
        if (sectionId !== null) {
          const { rows: section } = await tx.query('SELECT id FROM sections WHERE id = $1 AND course_id = $2', [sectionId, courseId]);
          if (!section[0]) return 'missing';
        }
        if (existing[0]) {
          await tx.query('UPDATE watches SET active = true WHERE id = $1', [existing[0].id]);
        } else {
          await tx.query(
            'INSERT INTO watches (user_id, course_id, section_id, unsubscribe_token) VALUES ($1, $2, $3, $4)',
            [user.id, courseId, sectionId, newToken(18)],
          );
        }
        return 'created';
      });
      if (result === 'limit') throw new HttpError(409, `You can have ${config.watchLimit} active alerts. Remove one to add another.`);
      if (result === 'missing') throw new HttpError(404, 'That class no longer exists. Search again.');
      if (result === 'exists') throw new HttpError(409, 'You already have this alert.');
      await bumpCounter(db, 'watches_created');
      sendJson(ctx.res, 201, { ok: true });
    }),

    route('DELETE', '/api/watches/([^/]+)', async (ctx) => {
      const user = requireUser(ctx);
      await db.query('UPDATE watches SET active = false WHERE id = $1 AND user_id = $2', [intParam(ctx.params[0]), user.id]);
      sendJson(ctx.res, 200, { ok: true });
    }),

    // Delivery settings
    route('POST', '/api/settings', async (ctx) => {
      const user = requireUser(ctx);
      const input = await ctx.body();
      if (typeof input.emailEnabled !== 'boolean') throw new HttpError(400, 'Invalid setting.');
      await db.query('UPDATE users SET email_enabled = $2 WHERE id = $1', [user.id, input.emailEnabled]);
      sendJson(ctx.res, 200, { ok: true });
    }),

    route('POST', '/api/push/subscribe', async (ctx) => {
      const user = requireUser(ctx);
      const input = await ctx.body();
      const keys = (input.keys ?? {}) as Record<string, unknown>;
      const endpoint = typeof input.endpoint === 'string' ? input.endpoint : '';
      if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || endpoint.length > 1024) {
        throw new HttpError(400, 'Invalid push subscription.');
      }
      let host: string;
      try {
        host = new URL(endpoint).hostname;
      } catch {
        throw new HttpError(400, 'Invalid push subscription.');
      }
      if (!hostAllowed(host, config.push.allowedHosts)) throw new HttpError(400, 'This browser\'s push service is not supported.');
      await db.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [user.id, endpoint, keys.p256dh, keys.auth],
      );
      sendJson(ctx.res, 201, { ok: true });
    }),

    route('POST', '/api/push/unsubscribe', async (ctx) => {
      const user = requireUser(ctx);
      const input = await ctx.body();
      await db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [user.id, String(input.endpoint ?? '')]);
      sendJson(ctx.res, 200, { ok: true });
    }),

    route('POST', '/api/test-alert', async (ctx) => {
      const user = requireUser(ctx);
      if (!(await underLimit(db, `test:${user.id}`, 5, 3600))) {
        throw new HttpError(429, 'Test alerts are limited to 5 an hour.');
      }
      await enqueue(db, 'send_test', { userId: user.id }, { dedupeKey: `test:${user.id}`, maxAttempts: 2, priority: 10 });
      sendJson(ctx.res, 202, { ok: true });
    }),

    route('POST', '/api/feedback', async (ctx) => {
      const input = await ctx.body();
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const kind = ['bug', 'idea', 'praise', 'other'].includes(String(input.kind)) ? String(input.kind) : 'other';
      if (message.length < 3 || message.length > 4000) throw new HttpError(400, 'Write a short message first.');
      if (!(await underLimit(db, `feedback:${ctx.ip}`, 10, 3600))) {
        throw new HttpError(429, 'Too many messages. Try again later.');
      }
      const contact = ctx.user?.email ?? (typeof input.contact === 'string' ? input.contact.trim().slice(0, 254) || null : null);
      await db.query('INSERT INTO feedback (user_id, contact, kind, message) VALUES ($1, $2, $3, $4)', [ctx.user?.id ?? null, contact, kind, message]);
      sendJson(ctx.res, 201, { ok: true });
    }),

    route('POST', '/api/account/delete', async (ctx) => {
      const user = requireUser(ctx);
      await db.query('DELETE FROM users WHERE id = $1', [user.id]);
      ctx.res.setHeader('set-cookie', sessionCookie('', 0));
      sendJson(ctx.res, 200, { ok: true });
    }),
  ];

  async function watchLabel(token: string): Promise<string | null> {
    const { rows } = await db.query<{ subject: string; catalog_nbr: string; class_nbr: string | null }>(
      `SELECT c.subject, c.catalog_nbr, s.class_nbr FROM watches w
         JOIN courses c ON c.id = w.course_id LEFT JOIN sections s ON s.id = w.section_id
        WHERE w.unsubscribe_token = $1`,
      [token],
    );
    const r = rows[0];
    if (!r) return null;
    return `${r.subject} ${r.catalog_nbr}${r.class_nbr ? ` (class ${r.class_nbr})` : ''}`;
  }

  function csrfOk(req: IncomingMessage): boolean {
    const given = req.headers.origin;
    if (given) return given === origin;
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<string> {
    res.setHeader('content-security-policy', CSP);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (secure) res.setHeader('strict-transport-security', 'max-age=31536000');

    const url = new URL(req.url ?? '/', origin);
    const method = req.method ?? 'GET';

    const file = staticFiles.get(url.pathname);
    if (file && (method === 'GET' || method === 'HEAD')) {
      const headers = {
        'content-type': file.type,
        etag: file.etag,
        'cache-control': url.pathname === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
      };
      if (req.headers['if-none-match'] === file.etag) res.writeHead(304, headers).end();
      else res.writeHead(200, headers).end(method === 'HEAD' ? undefined : file.body);
      return 'static';
    }

    for (const candidate of routes) {
      const match = candidate.method === method ? candidate.pattern.exec(url.pathname) : null;
      if (!match) continue;
      if (method !== 'GET' && !candidate.csrfExempt && !csrfOk(req)) throw new HttpError(403, 'Request blocked. Reload the page and try again.');
      const isOps = candidate.label.startsWith('/healthz') || candidate.label === '/readyz' || candidate.label === '/metrics';
      const user = isOps ? null : await loadUser(req);
      if (user) await noteActivity(user.id);
      await candidate.handler({
        req,
        res,
        url,
        params: match.slice(1),
        user,
        ip: clientIp(req),
        body: async () => {
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
          try {
            const parsed: unknown = JSON.parse(await readBody(req));
            if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
            return parsed as Record<string, unknown>;
          } catch (err) {
            if (err instanceof HttpError) throw err;
            throw new HttpError(400, 'That request could not be read.');
          }
        },
      });
      return candidate.label;
    }
    throw new HttpError(404, 'Not found.');
  }

  return createServer((req, res) => {
    const started = performance.now();
    void handle(req, res)
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) log.error('request failed', { path: req.url, error: errorMessage(err) });
        if (res.headersSent) {
          res.end();
          return 'error';
        }
        const message = err instanceof HttpError ? err.message : 'Something went wrong on our side. Try again.';
        if ((req.url ?? '').startsWith('/api/') || status !== 404) sendJson(res, status, { error: message });
        else sendHtml(res, 404, pages.notFoundPage(config));
        return status === 404 ? 'not_found' : 'error';
      })
      .then((label) => {
        metrics.httpRequests.inc({ route: label, method: req.method ?? '', status: String(res.statusCode) });
        metrics.httpDuration.observe((performance.now() - started) / 1000, { route: label });
      });
  });
}
