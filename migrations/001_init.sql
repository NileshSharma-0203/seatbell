-- Accounts ---------------------------------------------------------------
CREATE TABLE users (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  email_enabled boolean NOT NULL DEFAULT true,
  signup_source text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_codes (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_email ON login_codes (email, created_at DESC);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Catalog snapshot ---------------------------------------------------------
CREATE TABLE courses (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term                 text NOT NULL,
  subject              text NOT NULL,
  catalog_nbr          text NOT NULL,
  title                text,
  next_poll_at         timestamptz NOT NULL DEFAULT now(),
  last_polled_at       timestamptz,
  last_success_at      timestamptz,
  last_section_count   integer,
  last_error           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (term, subject, catalog_nbr)
);
CREATE INDEX courses_due ON courses (next_poll_at);

CREATE TABLE sections (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id       integer NOT NULL REFERENCES courses ON DELETE CASCADE,
  class_nbr       text NOT NULL,
  title           text,
  instructors     text,
  days            text,
  start_time      text,
  end_time        text,
  location        text,
  session_code    text,
  enrolled        integer NOT NULL,
  capacity        integer NOT NULL,
  open_seats      integer NOT NULL CHECK (open_seats >= 0),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, class_nbr)
);

-- One row per closed-to-open transition; the anchor for delivery idempotency.
CREATE TABLE seat_openings (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id integer NOT NULL REFERENCES sections ON DELETE CASCADE,
  open_seats integer NOT NULL,
  opened_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seat_openings_section ON seat_openings (section_id, opened_at DESC);

-- What people asked to hear about -------------------------------------------
CREATE TABLE watches (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           integer NOT NULL REFERENCES users ON DELETE CASCADE,
  course_id         integer NOT NULL REFERENCES courses ON DELETE CASCADE,
  section_id        integer REFERENCES sections ON DELETE CASCADE, -- NULL = any section
  active            boolean NOT NULL DEFAULT true,
  unsubscribe_token text NOT NULL UNIQUE,
  last_notified_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX watches_one_per_target
  ON watches (user_id, course_id, COALESCE(section_id, 0));
CREATE INDEX watches_course_active ON watches (course_id) WHERE active;

CREATE TABLE push_subscriptions (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         integer NOT NULL REFERENCES users ON DELETE CASCADE,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  label           text,
  last_success_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);

CREATE TABLE notifications (
  id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  opening_id           integer NOT NULL REFERENCES seat_openings ON DELETE CASCADE,
  watch_id             integer NOT NULL REFERENCES watches ON DELETE CASCADE,
  channel              text NOT NULL CHECK (channel IN ('email', 'push')),
  push_subscription_id integer REFERENCES push_subscriptions ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'sent', 'failed', 'expired', 'skipped')),
  provider_id          text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz
);
CREATE UNIQUE INDEX notifications_once
  ON notifications (opening_id, watch_id, channel, COALESCE(push_subscription_id, 0));
CREATE INDEX notifications_sent ON notifications (sent_at) WHERE status = 'sent';

-- Job queue ------------------------------------------------------------------
CREATE TABLE jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  dedupe_key   text,
  priority     integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'dead')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_by    text,
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_claim ON jobs (kind, priority DESC, run_at, id) WHERE status = 'queued';
CREATE INDEX jobs_expired ON jobs (locked_until) WHERE status = 'running';
CREATE INDEX jobs_finished ON jobs (finished_at) WHERE status IN ('done', 'dead');
CREATE UNIQUE INDEX jobs_dedupe_active ON jobs (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- Product and operations -----------------------------------------------------
CREATE TABLE feedback (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer REFERENCES users ON DELETE SET NULL,
  contact    text,
  kind       text NOT NULL CHECK (kind IN ('bug', 'idea', 'praise', 'other')),
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE daily_active (
  day     date NOT NULL,
  user_id integer NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (day, user_id)
);

CREATE TABLE daily_counters (
  day   date NOT NULL,
  name  text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);

CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE system_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
