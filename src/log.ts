type Fields = Record<string, unknown>;

function write(level: 'info' | 'warn' | 'error', msg: string, fields?: Fields): void {
  if (process.env.LOG_SILENT === 'true') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
}

export const log = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
