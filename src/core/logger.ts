// src/core/logger.ts
import pino from 'pino'

// Logger 初始化一次后作为单例导出。
// 在测试中，直接从 'pino' 导入以避免加载配置。
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
