import 'dotenv/config'
// Sentry / Better Stack Errors — must load before Nest bootstraps anything else.
import './instrument'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { BetterStackLogger } from './common/better-stack.logger'

async function bootstrap() {
  const logger = new BetterStackLogger()

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
    logger,
  })
  app.useLogger(logger)
  app.enableShutdownHooks()

  // FRONTEND_URL may be a single URL or a comma-separated list — lets us
  // allowlist both the bare apex ("https://databerry.app") and the www
  // subdomain ("https://www.databerry.app") from the same env var, which
  // the browser treats as distinct origins for CORS purposes.
  //
  // For server-issued redirects (OAuth callbacks) only the FIRST entry is
  // used — see `common/frontend-url.ts`. Put the canonical host first.
  const extraOrigins = (process.env.FRONTEND_URL ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  app.enableCors({
    origin: ['http://localhost:3000', 'http://localhost:3001', ...extraOrigins],
    credentials: true,
  })

  const port = process.env.PORT ?? 3001
  await app.listen(port)

  logger.log(
    `Backend running on port ${port}` +
      (logger.enabled ? ' (Better Stack logs on)' : ' (Better Stack logs off)') +
      (process.env.BETTER_STACK_ERRORS_DSN?.trim()
        ? ' (Better Stack errors on)'
        : ' (Better Stack errors off)'),
    'Bootstrap',
  )

  // Drain the Better Stack batch on process exit so the last few lines
  // aren't dropped when Railway / local Ctrl-C kills the process.
  const flush = async () => {
    await logger.flush()
  }
  process.once('beforeExit', () => {
    void flush()
  })
  process.once('SIGTERM', () => {
    void flush()
  })
  process.once('SIGINT', () => {
    void flush()
  })
}

bootstrap()
