import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true })

  // FRONTEND_URL may be a single URL or a comma-separated list — lets us
  // allowlist both the bare apex ("https://databerry.app") and the www
  // subdomain ("https://www.databerry.app") from the same env var, which
  // the browser treats as distinct origins for CORS purposes.
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
  console.log(`\n  Backend running on port ${port}\n`)
}

bootstrap()
