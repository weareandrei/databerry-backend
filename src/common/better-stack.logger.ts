import { ConsoleLogger, type LogLevel } from '@nestjs/common'
import { Logtail } from '@logtail/node'

/**
 * Nest ConsoleLogger that also ships every log line to Better Stack
 * (Logtail). When `BETTER_STACK_SOURCE_TOKEN` / `BETTER_STACK_INGESTING_HOST`
 * are unset, it behaves exactly like the default console logger.
 *
 * Wire with:
 *   const logger = new BetterStackLogger()
 *   const app = await NestFactory.create(AppModule, { bufferLogs: true, logger })
 *   app.useLogger(logger)
 * and call `await logger.flush()` on shutdown so the last batch is sent.
 */
export class BetterStackLogger extends ConsoleLogger {
  private readonly logtail: Logtail | null

  constructor() {
    super()

    const sourceToken = process.env.BETTER_STACK_SOURCE_TOKEN?.trim()
    const endpoint = process.env.BETTER_STACK_INGESTING_HOST?.trim()

    this.logtail =
      sourceToken && endpoint
        ? new Logtail(sourceToken, {
            endpoint,
            // Telemetry must never take down the API process.
            ignoreExceptions: true,
          })
        : null
  }

  override log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(message, ...optionalParams)
    this.ship('info', message, optionalParams)
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams)
    this.ship('error', message, optionalParams)
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(message, ...optionalParams)
    this.ship('warn', message, optionalParams)
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(message, ...optionalParams)
    this.ship('debug', message, optionalParams)
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(message, ...optionalParams)
    this.ship('debug', message, optionalParams)
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(message, ...optionalParams)
    this.ship('error', message, optionalParams)
  }

  /** Flush any buffered Better Stack batches. Safe no-op when unset. */
  async flush(): Promise<void> {
    await this.logtail?.flush()
  }

  get enabled(): boolean {
    return this.logtail != null
  }

  private ship(
    level: Extract<LogLevel, 'debug' | 'log' | 'warn' | 'error'> | 'info',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (!this.logtail) return

    const nestContext = this.extractContext(optionalParams)
    const text = this.formatForBetterStack(message)
    const context: Record<string, unknown> = {
      service: 'databerry-backend',
      nestContext,
    }

    // Nest's error(message, stack?, context?) — when two trailing strings
    // are present the first is the stack trace.
    if (level === 'error' && optionalParams.length >= 2) {
      const maybeStack = optionalParams[0]
      if (typeof maybeStack === 'string' && maybeStack.includes('\n')) {
        context.stack = maybeStack
      }
    }

    const logtailLevel = level === 'log' ? 'info' : level
    void this.logtail[logtailLevel](text, context)
  }

  private extractContext(optionalParams: unknown[]): string | undefined {
    const last = optionalParams[optionalParams.length - 1]
    if (typeof last === 'string') return last
    return this.context
  }

  private formatForBetterStack(message: unknown): string {
    if (typeof message === 'string') return message
    if (message instanceof Error) return message.stack ?? message.message
    try {
      return JSON.stringify(message)
    } catch {
      return String(message)
    }
  }
}
