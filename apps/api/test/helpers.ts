import { pino } from 'pino';
import { loadConfig } from '../src/config.js';

/** Production defaults, quiet logs. Tests override individual limits as needed. */
export const testConfig = loadConfig({ NODE_ENV: 'test', HOST: '127.0.0.1', LOG_LEVEL: 'silent' });

export const silentLogger = pino({ level: 'silent' });

/** Logger that records entries in memory so tests can assert on what was logged. */
export function memoryLogger() {
  const entries: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'trace' },
    { write: (line: string) => entries.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, entries };
}
