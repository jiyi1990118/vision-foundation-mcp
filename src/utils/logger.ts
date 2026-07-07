/**
 * Structured logger — outputs to stderr (stdout is reserved for MCP protocol).
 */
type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[currentLevel]) return;
  const ts = new Date().toISOString();
  const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
  process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${message}${metaStr}\n`);
}

export const logger = {
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
};
