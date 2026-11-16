import { loadConfig } from './config.ts';
import { createDb, migrate } from './db.ts';
import { log, errorMessage } from './log.ts';

const db = createDb(loadConfig().databaseUrl, 1);
try {
  const applied = await migrate(db);
  log.info('migrations complete', { applied });
} catch (err) {
  log.error('migration failed', { error: errorMessage(err) });
  process.exitCode = 1;
} finally {
  await db.close();
}
