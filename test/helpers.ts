import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { createDb, migrate } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import type { SectionSnapshot } from '../src/asu/parse.ts';
import type { EmailMessage, PushMessage, Senders } from '../src/notify/send.ts';

process.env.LOG_SILENT = 'true';

export const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/seatbell_test';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_URL,
    BASE_URL: 'http://localhost:3000',
    TERMS: '2271:Spring 2027',
    POLL_MIN_SPACING_MS: '0',
    VAPID_SUBJECT: 'mailto:test@example.com',
    PUSH_ALLOWED_HOSTS: 'push.test',
    ...overrides,
  });
}

export async function freshDb(): Promise<Db> {
  const db = createDb(TEST_URL, 20);
  await db.query('DROP SCHEMA public CASCADE');
  await db.query('CREATE SCHEMA public');
  await migrate(db);
  return db;
}

export function section(classNbr: string, enrolled: number, capacity = 30, extra: Partial<SectionSnapshot> = {}): SectionSnapshot {
  return {
    classNbr,
    title: 'Data Structures',
    instructors: 'Grace Hopper',
    days: 'T Th',
    startTime: '10:30 AM',
    endTime: '11:45 AM',
    location: 'BYENG 210',
    sessionCode: 'C',
    enrolled,
    capacity,
    openSeats: Math.max(capacity - enrolled, 0),
    ...extra,
  };
}

export interface FakeSenders extends Senders {
  emails: EmailMessage[];
  pushes: PushMessage[];
}

export function fakeSenders(): FakeSenders {
  const emails: EmailMessage[] = [];
  const pushes: PushMessage[] = [];
  return {
    emails,
    pushes,
    email: async (m) => {
      emails.push(m);
      return 'email-id';
    },
    push: async (_t, m) => {
      pushes.push(m);
      return 'push-id';
    },
  };
}

export async function seedUser(db: Db, email: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [email]);
  return rows[0]!.id;
}

export async function seedCourse(db: Db, subject = 'CSE', nbr = '310'): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO courses (term, subject, catalog_nbr) VALUES ('2271', $1, $2) RETURNING id`,
    [subject, nbr],
  );
  return rows[0]!.id;
}

export async function sectionId(db: Db, courseId: number, classNbr: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM sections WHERE course_id = $1 AND class_nbr = $2', [courseId, classNbr]);
  return rows[0]!.id;
}

let tokenCounter = 0;
export async function seedWatch(db: Db, userId: number, courseId: number, section: number | null): Promise<number> {
  tokenCounter += 1;
  const { rows } = await db.query<{ id: number }>(
    'INSERT INTO watches (user_id, course_id, section_id, unsubscribe_token) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, courseId, section, `token-${tokenCounter}`],
  );
  return rows[0]!.id;
}

export async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
