import type { Config } from '../config.ts';
import { bumpCounter } from '../db.ts';
import type { Db } from '../db.ts';
import { log } from '../log.ts';
import { metrics } from '../metrics.ts';
import { PermanentDeliveryError, SubscriptionGoneError } from '../notify/send.ts';
import type { Senders } from '../notify/send.ts';
import { alertEmail, alertPush, testEmail } from '../notify/templates.ts';
import type { AlertInfo } from '../notify/templates.ts';

// A seat that opened half an hour ago is almost certainly gone; a late alert only wastes trust.
const EXPIRE_AFTER_MS = 30 * 60_000;

interface NotificationRow {
  id: number;
  status: string;
  channel: 'email' | 'push';
  watch_active: boolean;
  any_section: boolean;
  unsubscribe_token: string;
  email: string;
  email_enabled: boolean;
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
  subscription_id: number | null;
  open_seats: number;
  opened_at: Date;
  class_nbr: string;
  days: string | null;
  start_time: string | null;
  instructors: string | null;
  term: string;
  subject: string;
  catalog_nbr: string;
  title: string | null;
}

export async function deliverNotification(db: Db, config: Config, senders: Senders, notificationId: number): Promise<void> {
  const { rows } = await db.query<NotificationRow>(
    `SELECT n.id, n.status, n.channel, w.active AS watch_active, w.section_id IS NULL AS any_section,
            w.unsubscribe_token, u.email, u.email_enabled,
            p.endpoint, p.p256dh, p.auth, p.id AS subscription_id,
            o.open_seats, o.opened_at, s.class_nbr, s.days, s.start_time, s.instructors,
            c.term, c.subject, c.catalog_nbr, COALESCE(s.title, c.title) AS title
       FROM notifications n
       JOIN watches w ON w.id = n.watch_id
       JOIN users u ON u.id = w.user_id
       JOIN seat_openings o ON o.id = n.opening_id
       JOIN sections s ON s.id = o.section_id
       JOIN courses c ON c.id = s.course_id
       LEFT JOIN push_subscriptions p ON p.id = n.push_subscription_id
      WHERE n.id = $1`,
    [notificationId],
  );
  const n = rows[0];
  if (!n || n.status !== 'queued') return;

  const finish = async (status: string, providerId: string | null, error: string | null): Promise<void> => {
    await db.query(
      `UPDATE notifications SET status = $2, provider_id = $3, error = $4,
              sent_at = CASE WHEN $2 = 'sent' THEN now() END WHERE id = $1`,
      [n.id, status, providerId, error?.slice(0, 500) ?? null],
    );
    metrics.notifications.inc({ channel: n.channel, outcome: status });
  };

  if (!n.watch_active || (n.channel === 'email' && !n.email_enabled)) return finish('skipped', null, null);
  if (Date.now() - n.opened_at.getTime() > EXPIRE_AFTER_MS) return finish('expired', null, null);

  if (n.channel === 'email' && config.email.dailyAlertBudget > 0) {
    // Alerts must not be able to use up the quota that sign-in codes depend on.
    const { rows: sent } = await db.query<{ value: string }>(
      `SELECT value FROM daily_counters WHERE day = (now() AT TIME ZONE 'America/Phoenix')::date AND name = 'alerts_email'`,
    );
    if (Number(sent[0]?.value ?? 0) >= config.email.dailyAlertBudget) {
      log.warn('daily email budget reached', { notificationId: n.id });
      return finish('failed', null, 'daily email budget reached');
    }
  }

  const info: AlertInfo = {
    subject: n.subject,
    catalogNbr: n.catalog_nbr,
    title: n.title,
    classNbr: n.class_nbr,
    openSeats: n.open_seats,
    termLabel: config.terms.find((t) => t.code === n.term)?.label ?? n.term,
    days: n.days,
    startTime: n.start_time,
    instructors: n.instructors,
    anySection: n.any_section,
    unsubscribeUrl: `${config.baseUrl}/u/${n.unsubscribe_token}`,
  };

  try {
    let providerId: string | null;
    if (n.channel === 'email') {
      providerId = await senders.email({ ...alertEmail(config, info), to: n.email, idempotencyKey: `notification-${n.id}` });
    } else {
      if (!n.endpoint || !n.p256dh || !n.auth) return finish('skipped', null, 'subscription removed');
      providerId = await senders.push({ endpoint: n.endpoint, p256dh: n.p256dh, auth: n.auth }, alertPush(info, `section-${n.class_nbr}`));
      await db.query('UPDATE push_subscriptions SET last_success_at = now() WHERE id = $1', [n.subscription_id]);
    }
    await finish('sent', providerId, null);
    await bumpCounter(db, `alerts_${n.channel}`);
    metrics.alertLatency.observe((Date.now() - n.opened_at.getTime()) / 1000, { channel: n.channel });
  } catch (err) {
    if (err instanceof SubscriptionGoneError) {
      await finish('failed', null, err.message);
      await db.query('DELETE FROM push_subscriptions WHERE id = $1', [n.subscription_id]);
      return;
    }
    if (err instanceof PermanentDeliveryError) {
      await finish('failed', null, err.message);
      log.error('notification permanently failed', { notificationId: n.id, error: err.message });
      return;
    }
    throw err;
  }
}

export async function markExhausted(db: Db, notificationId: number, error: string): Promise<void> {
  await db.query(`UPDATE notifications SET status = 'failed', error = $2 WHERE id = $1 AND status = 'queued'`, [notificationId, error.slice(0, 500)]);
}

export async function sendTestAlert(db: Db, config: Config, senders: Senders, userId: number): Promise<void> {
  const { rows } = await db.query<{ email: string; email_enabled: boolean }>('SELECT email, email_enabled FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  if (!user) return;
  if (user.email_enabled) await senders.email({ ...testEmail(config), to: user.email });
  const { rows: subs } = await db.query<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId],
  );
  for (const sub of subs) {
    try {
      await senders.push(sub, {
        title: 'Test alert',
        body: `Push alerts from ${config.appName} are working on this device.`,
        url: `${config.baseUrl}/app`,
        tag: 'test',
      });
    } catch (err) {
      if (err instanceof SubscriptionGoneError) await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      else throw err;
    }
  }
}
