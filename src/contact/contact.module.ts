import { Module } from '@nestjs/common'
import { ContactController } from './contact.controller'
import { ContactService } from './contact.service'

/**
 * Contact form module — `POST /contact`. No Supabase / DB
 * dependency, so the module is intentionally tiny: just controller
 * + service. The service holds the Resend client; the controller
 * validates input + calls it.
 *
 * Registered in `AppModule` like the chat module.
 */
@Module({
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
