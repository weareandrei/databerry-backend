import {
  Controller,
  Logger,
  Post,
  Param,
  Body,
  RawBody,
  Headers,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import { CustomWebhookService } from './custom-webhook.service'
import { StripeWebhookService } from '../stripe/webhook/handler'
import { PosthogWebhookService } from '../posthog/webhook/handler'

// This controller has NO auth guard — PostHog and Stripe call it directly
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name)

  constructor(
    private readonly customWebhookService: CustomWebhookService,
    private readonly stripeWebhookService: StripeWebhookService,
    private readonly posthogWebhookService: PosthogWebhookService,
  ) {}

  @Post('posthog/:connectionId/:viewId')
  @HttpCode(HttpStatus.OK)
  handlePosthogWebhook(
    @Param('connectionId') connectionId: string,
    @Param('viewId') viewId: string,
    @Body() payload: Record<string, unknown>,
  ) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  📦 PostHog webhook received')
    console.log(`  connectionId : ${connectionId}`)
    console.log(`  viewId       : ${viewId}`)
    console.log('  full payload :')
    console.log(JSON.stringify(payload, null, 4))
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    // Fire-and-forget — PostHog expects a fast 200 back
    this.posthogWebhookService
      .handlePosthogEvent(connectionId, viewId, payload)
      .catch(err => this.logger.error('handlePosthogEvent failed', err?.message))
    return { ok: true }
  }

  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(@RawBody() rawBody: Buffer, @Headers('stripe-signature') sig: string) {
    if (!sig) throw new BadRequestException('Missing stripe-signature header')

    // Fire-and-forget — Stripe expects a fast 200 back
    this.stripeWebhookService
      .handleStripeEvent(rawBody, sig)
      .catch(err => this.logger.error('handleStripeEvent failed', err?.message))
    return { ok: true }
  }

  @Post('custom/:webhookId')
  @HttpCode(HttpStatus.OK)
  async handleCustomWebhook(
    @Param('webhookId') webhookId: string,
    @Headers('x-api-key') apiKey: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!apiKey) throw new BadRequestException('Missing X-API-Key header')
    await this.customWebhookService.handleCustomWebhook(webhookId, apiKey, body)
    return { ok: true }
  }
}
