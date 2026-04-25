import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../auth/supabase-auth.guard'
import type { AuthenticatedRequest } from '../../common/types'
import { StripeProductsService } from './products.service'

interface SetProductsBody {
  productIds: unknown
}

@UseGuards(SupabaseAuthGuard)
@Controller('stripe')
export class StripeProductsController {
  constructor(private readonly stripeProductsService: StripeProductsService) {}

  /**
   * List products available for a connection (from its Stripe account) and
   * the currently-saved filter selection. Powers the picker modal.
   */
  @Get('connections/:connectionId/products')
  async listProducts(
    @Param('connectionId') connectionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stripeProductsService.listProductsForConnection(
      connectionId,
      req.authUser.id,
    )
  }

  /**
   * Replace the connection's product filter. Empty array = "All products".
   */
  @Post('connections/:connectionId/products')
  async saveProducts(
    @Param('connectionId') connectionId: string,
    @Body() body: SetProductsBody,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!Array.isArray(body?.productIds) || !body.productIds.every(id => typeof id === 'string')) {
      throw new BadRequestException('productIds must be an array of strings')
    }
    return this.stripeProductsService.setProductFilter(
      connectionId,
      body.productIds as string[],
      req.authUser.id,
    )
  }

  /**
   * Backfill status for the underlying Stripe account. Frontend polls this
   * (~5s) while the post-creation modal is open so it can switch from a
   * "Importing…" banner to a normal product list.
   */
  @Get('accounts/:stripeAccountId/status')
  async getAccountStatus(
    @Param('stripeAccountId') stripeAccountId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.stripeProductsService.getAccountStatus(stripeAccountId, req.authUser.id)
  }
}
