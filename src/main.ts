import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`\n  Backend running on port ${port}`);

  // If no WEBHOOK_BASE_URL set, tunnel via ngrok for local dev
  if (!process.env.WEBHOOK_BASE_URL && process.env.NGROK_AUTHTOKEN) {
    const ngrok = await import('@ngrok/ngrok');
    const listener = await ngrok.connect({
      addr: Number(port),
      authtoken: process.env.NGROK_AUTHTOKEN,
    });
    process.env.WEBHOOK_BASE_URL = listener.url() ?? undefined;
    console.log(`  Ngrok tunnel established: ${process.env.WEBHOOK_BASE_URL}`);
    console.log(`  WEBHOOK_BASE_URL set automatically\n`);
  }
}

bootstrap();
