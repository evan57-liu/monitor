// src/core/logger.ts
import pino from 'pino'

// Logger is initialised once and exported as a singleton.
// In tests, import directly from 'pino' to avoid config loading.
let _logger: pino.Logger | null = null

export function initLogger(logLevel: string): pino.Logger {
  if (process.env['NODE_ENV'] !== 'production') {
    _logger = pino({
      level: logLevel,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
    })
  } else {
    _logger = pino({ level: logLevel })
  }
  return _logger
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = pino({ level: 'info' })
  }
  return _logger
}
