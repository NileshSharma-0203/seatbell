// Prints the numbers that go on your resume: npm run stats
// Uptime isn't here on purpose. Take it from the external monitor, which doesn't share this server's fate.
import { loadConfig } from './config.ts';
import { createDb } from './db.ts';

const db = createDb(loadConfig().databaseUrl, 1);
const day = "(now() AT TIME ZONE 'America/Phoenix')::date";

const { rows } = await db.query(`
  SELECT
    (SELECT count(*)::int FROM users) AS users,
    (SELECT count(DISTINCT user_id)::int FROM watches) AS activated_users,
    (SELECT count(*)::int FROM daily_active WHERE day = ${day}) AS dau,
    (SELECT count(DISTINCT user_id)::int FROM daily_active WHERE day > ${day} - 7) AS wau,
    (SELECT count(DISTINCT user_id)::int FROM daily_active WHERE day > ${day} - 30) AS mau,
    (SELECT count(*)::int FROM watches WHERE active) AS active_watches,
    (SELECT count(DISTINCT course_id)::int FROM watches WHERE active) AS tracked_courses,
    (SELECT count(*)::int FROM seat_openings) AS seat_openings,
    (SELECT COALESCE(sum(value), 0)::int FROM daily_counters WHERE name = 'alerts_email') AS alerts_email,
    (SELECT COALESCE(sum(value), 0)::int FROM daily_counters WHERE name = 'alerts_push') AS alerts_push,
    (SELECT COALESCE(sum(value), 0)::int FROM daily_counters WHERE name = 'polls_ok') AS polls_ok,
    (SELECT COALESCE(sum(value), 0)::int FROM daily_counters WHERE name = 'polls_failed') AS polls_failed,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM n.sent_at - o.opened_at))::float8
       FROM notifications n JOIN seat_openings o ON o.id = n.opening_id WHERE n.status = 'sent') AS median_send_seconds,
    (SELECT count(*)::int FROM notifications WHERE status = 'failed') AS failed_alerts,
    (SELECT count(*)::int FROM jobs WHERE status = 'dead') AS dead_jobs,
    (SELECT count(*)::int FROM feedback) AS feedback_messages
`);
const { rows: sources } = await db.query(
  `SELECT COALESCE(signup_source, 'direct') AS source, count(*)::int AS users FROM users GROUP BY 1 ORDER BY 2 DESC`,
);
const { rows: daily } = await db.query(
  `SELECT day::text, count(*)::int AS active FROM daily_active WHERE day > ${day} - 14 GROUP BY day ORDER BY day`,
);

const r = rows[0]!;
const polls = r.polls_ok + r.polls_failed;
console.table({
  'Registered users': r.users,
  'Users with at least one alert': r.activated_users,
  'Active today': r.dau,
  'Active in 7 days': r.wau,
  'Active in 30 days': r.mau,
  'Active watches': r.active_watches,
  'Courses tracked': r.tracked_courses,
  'Seat openings detected': r.seat_openings,
  'Alerts sent (email)': r.alerts_email,
  'Alerts sent (push)': r.alerts_push,
  'Alerts sent (total)': r.alerts_email + r.alerts_push,
  'Failed alerts': r.failed_alerts,
  'Median detect-to-send (s)': r.median_send_seconds === null ? 'n/a' : Number(r.median_send_seconds).toFixed(2),
  'Seat check success': polls ? `${((100 * r.polls_ok) / polls).toFixed(2)}% of ${polls}` : 'n/a',
  'Dead-lettered jobs': r.dead_jobs,
  'Feedback messages': r.feedback_messages,
});
console.log('Signups by source');
console.table(sources);
console.log('Daily active users, last 14 days');
console.table(daily);
await db.close();
