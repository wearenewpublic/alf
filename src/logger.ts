// ABOUTME: Pino-based structured logger for ALF (Atproto Latency Fabric) service

import pino from 'pino';

const isTestEnv = process.env.NODE_ENV === 'test';
const enableTestLogging = process.env.ENABLE_TEST_LOGGING === 'true';

export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  enabled: !isTestEnv || enableTestLogging,
});

interface LogContext {
  [key: string]: string | number | boolean | null | undefined;
}

export class Logger {
  private child: pino.Logger;

  constructor(module: string) {
    this.child = rootLogger.child({ module });
  }

  info(message: string, context?: LogContext): void {
    this.child.info(context ?? {}, message);
  }

  warn(message: string, context?: LogContext): void {
    this.child.warn(context ?? {}, message);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.child.error({ err: error, ...context }, message);
  }
}

export function createLogger(module: string): Logger {
  return new Logger(module);
}
