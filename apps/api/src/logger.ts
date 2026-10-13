import { pino } from 'pino';
import type { DestinationStream, Logger } from 'pino';
import type { Config } from './config.js';

/** Structured JSON logs to stdout by default; the platform's log collector does the rest. */
export function createLogger(
  config: Pick<Config, 'logLevel'>,
  destination?: DestinationStream,
): Logger {
  const options = {
    level: config.logLevel,
    redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
  };
  return destination ? pino(options, destination) : pino(options);
}
