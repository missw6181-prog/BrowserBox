import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { configManager } from '../config/ConfigManager'

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export class Logger {
  private write(level: Level, scope: string, message: string, details?: unknown): void {
    const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}${
      details !== undefined ? ' ' + JSON.stringify(details) : ''
    }\n`
    // eslint-disable-next-line no-console
    console.log(line.trimEnd())
    try {
      if (!configManager.isReady()) return
      const dir = configManager.resolvePath('Logs')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'app.log'), line, 'utf8')
    } catch {
      /* ignore */
    }
  }

  debug(scope: string, message: string, details?: unknown): void {
    this.write('DEBUG', scope, message, details)
  }
  info(scope: string, message: string, details?: unknown): void {
    this.write('INFO', scope, message, details)
  }
  warn(scope: string, message: string, details?: unknown): void {
    this.write('WARN', scope, message, details)
  }
  error(scope: string, message: string, details?: unknown): void {
    this.write('ERROR', scope, message, details)
  }
}

export const logger = new Logger()
