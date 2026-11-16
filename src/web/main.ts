import { loadConfig } from '../config.ts';
import { createDb } from '../db.ts';
import { log } from '../log.ts';
import { createSenders } from '../notify/send.ts';
import { createApp } from './server.ts';

const config = loadConfig();
const db = createDb(config.databaseUrl, 10);
const server = createApp(db, config, createSenders(config));

server.listen(config.port, () => log.info('web started', { port: config.port, baseUrl: config.baseUrl }));

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  log.info('web stopping', { signal });
  server.close(() => void db.close().then(() => process.exit(0)));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
