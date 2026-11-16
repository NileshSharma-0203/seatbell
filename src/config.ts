export interface Term {
  code: string;
  label: string;
}

export interface Config {
  env: 'production' | 'development' | 'test';
  appName: string;
  baseUrl: string;
  port: number;
  workerPort: number;
  databaseUrl: string;
  sessionSecret: string;
  metricsToken: string | null;
  allowedEmailDomains: string[];
  contactEmail: string;
  terms: Term[];
  watchLimit: number;
  asu: {
    baseUrl: string;
    authorization: string | null;
    timeoutMs: number;
  };
  polling: {
    enabled: boolean;
    intervalMs: number;
    minSpacingMs: number;
    alertCooldownMs: number;
    breakerThreshold: number;
    breakerBaseMs: number;
    breakerMaxMs: number;
    staleAfterMs: number;
  };
  email: {
    provider: 'resend' | 'log';
    apiBase: string;
    apiKey: string | null;
    from: string;
    dailyAlertBudget: number;
  };
  push: {
    publicKey: string | null;
    privateKey: string | null;
    subject: string;
    allowedHosts: string[];
  };
}

const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  '*.push.apple.com',
  'updates.push.services.mozilla.com',
  '*.notify.windows.com',
];

function parseTerms(raw: string): Term[] {
  const terms = raw.split(',').map((entry) => {
    const [code, label] = entry.split(':').map((part) => part.trim());
    if (!code || !label || !/^\d{4}$/.test(code)) {
      throw new Error(`Invalid term "${entry}". Use the form 2271:Spring 2027`);
    }
    return { code, label };
  });
  if (terms.length === 0) throw new Error('TERMS must list at least one term');
  return terms;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.NODE_ENV ?? 'development') as Config['env'];
  const required = (name: string, devDefault: string): string => {
    const value = env[name];
    if (value) return value;
    if (mode === 'production') throw new Error(`Missing required env var ${name}`);
    return devDefault;
  };
  const number = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
    return value;
  };

  const sessionSecret = required('SESSION_SECRET', 'development-only-secret-do-not-deploy');
  if (mode === 'production' && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  const emailProvider = (env.EMAIL_PROVIDER ?? (mode === 'production' ? 'resend' : 'log')) as 'resend' | 'log';
  if (mode === 'production' && emailProvider !== 'resend') {
    throw new Error('EMAIL_PROVIDER must be resend in production');
  }

  return {
    env: mode,
    appName: env.APP_NAME ?? 'Seatbell',
    baseUrl: required('BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
    port: number('PORT', 3000),
    workerPort: number('WORKER_PORT', 9091),
    databaseUrl: required('DATABASE_URL', 'postgres://localhost:5432/seatbell'),
    sessionSecret,
    metricsToken: env.METRICS_TOKEN || null,
    allowedEmailDomains: (env.ALLOWED_EMAIL_DOMAINS ?? 'asu.edu')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    contactEmail: required('CONTACT_EMAIL', 'hello@example.com'),
    terms: parseTerms(env.TERMS ?? '2271:Spring 2027'),
    watchLimit: number('WATCH_LIMIT', 10),
    asu: {
      baseUrl: (env.ASU_API_BASE ?? 'https://eadvs-cscc-catalog-api.apps.asu.edu/catalog-microservices/api/v1').replace(/\/$/, ''),
      authorization: env.ASU_AUTHORIZATION || null,
      timeoutMs: number('ASU_TIMEOUT_MS', 10_000),
    },
    polling: {
      enabled: env.POLLING_ENABLED !== 'false',
      intervalMs: number('POLL_INTERVAL_MS', 90_000),
      minSpacingMs: number('POLL_MIN_SPACING_MS', 2_000),
      alertCooldownMs: number('ALERT_COOLDOWN_MS', 15 * 60_000),
      breakerThreshold: number('BREAKER_THRESHOLD', 5),
      breakerBaseMs: number('BREAKER_BASE_MS', 5 * 60_000),
      breakerMaxMs: number('BREAKER_MAX_MS', 60 * 60_000),
      staleAfterMs: number('POLLER_STALE_AFTER_MS', 10 * 60_000),
    },
    email: {
      provider: emailProvider,
      apiBase: (env.RESEND_API_BASE ?? 'https://api.resend.com').replace(/\/$/, ''),
      apiKey: emailProvider === 'resend' ? required('RESEND_API_KEY', '') : null,
      from: required('EMAIL_FROM', 'Seatbell <alerts@localhost>'),
      dailyAlertBudget: number('EMAIL_ALERT_DAILY_BUDGET', 0),
    },
    push: {
      publicKey: env.VAPID_PUBLIC_KEY || null,
      privateKey: env.VAPID_PRIVATE_KEY || null,
      subject: env.VAPID_SUBJECT ?? `mailto:${env.CONTACT_EMAIL ?? 'hello@example.com'}`,
      allowedHosts: env.PUSH_ALLOWED_HOSTS
        ? env.PUSH_ALLOWED_HOSTS.split(',').map((h) => h.trim())
        : DEFAULT_PUSH_HOSTS,
    },
  };
}
