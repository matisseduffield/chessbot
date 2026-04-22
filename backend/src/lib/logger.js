'use strict';

/**
 * Structured logger for the backend.
 *
 * In development (NODE_ENV !== 'production'), logs are pretty-printed
 * via pino-pretty with timestamps and colors. In production, logs are
 * emitted as line-delimited JSON on stdout, suitable for ingestion by
 * log aggregators.
 *
 * Create per-module child loggers with `logger.child({ module: 'ws' })`
 * or use the `forModule(name)` helper to keep log context consistent.
 */

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

const baseLogger = pino(
  {
    level,
    base: undefined, // drop pid/hostname noise
  },
  isProd
    ? pino.destination(1)
    : pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      }),
);

/**
 * Get a child logger bound to a specific module name.
 * @param {string} name
 */
function forModule(name) {
  return baseLogger.child({ module: name });
}

module.exports = {
  logger: baseLogger,
  forModule,
};
