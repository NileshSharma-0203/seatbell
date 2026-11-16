import { createServer } from 'node:http';
import { loadConfig } from '../config.ts';
import { createDb } from '../db.ts';
import { log } from '../log.ts';
import { renderMetrics } from '../metrics.ts';
import { createSeatSource } from '../asu/client.ts';
import { createSenders } from '../notify/send.ts';
import { startWorker } from './runner.ts';

const config = loadConfig();
const db = createDb(config.databaseUrl, 8);
const worker = startWorker(db, config, createSeatSource(config), createSenders(config));

const ops = createServer((req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(renderMetrics());
  } else if (req.url === '/healthz') {
    res.writeHead(200).end('ok');
  } else {
    res.writeHead(404).end();
  }
}).listen(config.workerPort);

log.info('worker started', { pollingEnabled: config.polling.enabled, port: config.workerPort });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info('worker stopping', { signal });
  ops.close();
  await worker.stop();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
