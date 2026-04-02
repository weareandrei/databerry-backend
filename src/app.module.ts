import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './supabase/supabase.module';
import { FoldersModule } from './folders/folders.module';
import { ConnectionsModule } from './connections/connections.module';
import { AccountsModule } from './accounts/accounts.module';
import { ViewsModule } from './views/views.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { StripeModule } from './stripe/stripe.module';

@Module({
  imports: [SupabaseModule, FoldersModule, ConnectionsModule, AccountsModule, ViewsModule, WebhooksModule, StripeModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
