import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import {
  ConnectionsRepository,
  type StripeCredentialTable,
} from '../../connections/connections.repository'
import { StripeRepository } from '../stripe.repository'
import { StripeBackfillService } from '../sync/backfill.service'

export interface StripeProductOption {
  id: string
  name: string
  active: boolean
}

export interface ProductsForConnectionResult {
  products: StripeProductOption[]
  selectedProductIds: string[]
  backfillComplete: boolean
  backfillStatus: 'pending' | 'in_progress' | 'complete' | 'error' | null
  backfillError: string | null
  stripeAccountId: string | null
}

export interface StripeAccountStatus {
  stripeAccountId: string
  backfillStatus: 'pending' | 'in_progress' | 'complete' | 'error' | null
  backfilledThrough: string | null
  lastSyncedAt: string | null
  backfillError: string | null
}

@Injectable()
export class StripeProductsService {
  private readonly logger = new Logger(StripeProductsService.name)

  constructor(
    private readonly connectionsRepository: ConnectionsRepository,
    private readonly stripeRepository: StripeRepository,
    private readonly backfillService: StripeBackfillService,
  ) {}

  async listProductsForConnection(
    connectionId: string,
    userId: string,
  ): Promise<ProductsForConnectionResult> {
    const { data: conn } = await this.connectionsRepository.findIdAndTypeByIdAndUserId(
      connectionId,
      userId,
    )
    if (!conn) throw new NotFoundException('Connection not found')

    const credential = await this.getCredentialForConnection(connectionId, conn.type as string)
    const stripeAccountId = credential?.stripeAccountId ?? null

    if (!stripeAccountId) {
      return {
        products: [],
        selectedProductIds: [],
        backfillComplete: false,
        backfillStatus: null,
        backfillError: null,
        stripeAccountId: null,
      }
    }

    const [productsRes, accountRes] = await Promise.all([
      this.stripeRepository.findProductsByAccount(stripeAccountId),
      this.stripeRepository.findBackfillInfo(stripeAccountId),
    ])

    if (productsRes.error) throw new Error(`stripe_products read: ${productsRes.error.message}`)

    const products: StripeProductOption[] = (productsRes.data ?? []).map(r => ({
      id: r.id as string,
      name: r.name as string,
      active: Boolean(r.active),
    }))
    const selectedProductIds = credential?.trackedProductIds ?? []
    const backfillStatus =
      (accountRes.data?.backfill_status as ProductsForConnectionResult['backfillStatus']) ?? null
    const backfillError = (accountRes.data?.backfill_error as string | null) ?? null

    return {
      products,
      selectedProductIds,
      backfillComplete: backfillStatus === 'complete',
      backfillStatus,
      backfillError,
      stripeAccountId,
    }
  }

  async setProductFilter(
    connectionId: string,
    productIds: string[],
    userId: string,
  ): Promise<{ selectedProductIds: string[] }> {
    const { data: conn } = await this.connectionsRepository.findIdAndTypeByIdAndUserId(
      connectionId,
      userId,
    )
    if (!conn) throw new NotFoundException('Connection not found')

    const credential = await this.getCredentialForConnection(connectionId, conn.type as string)
    const stripeAccountId = credential?.stripeAccountId ?? null
    if (!stripeAccountId) {
      throw new NotFoundException('Connection is not linked to a Stripe account yet')
    }

    const uniqueIds = Array.from(new Set(productIds))

    if (uniqueIds.length > 0) {
      const { data: known, error: knownErr } =
        await this.stripeRepository.findProductIdsByAccount(stripeAccountId, uniqueIds)
      if (knownErr) throw new Error(`stripe_products verify: ${knownErr.message}`)

      const knownIds = new Set((known ?? []).map(r => r.id as string))
      const unknown = uniqueIds.filter(id => !knownIds.has(id))
      if (unknown.length > 0) {
        throw new NotFoundException(
          `Unknown product id(s) for this account: ${unknown.join(', ')}`,
        )
      }
    }

    const credentialTable = this.credentialTableForType(conn.type as string)
    if (!credentialTable) {
      throw new NotFoundException('Connection is not a Stripe connection')
    }

    const { error: updErr } = await this.connectionsRepository.updateTrackedProductIds(
      connectionId,
      credentialTable,
      uniqueIds,
    )
    if (updErr) throw new Error(`${credentialTable} tracked_product_ids update: ${updErr.message}`)

    this.logger.log(
      `  ✓ setProductFilter  connection=${connectionId}  products=[${uniqueIds.join(', ') || '<all>'}]`,
    )
    return { selectedProductIds: uniqueIds }
  }

  async retryBackfill(stripeAccountId: string, userId: string): Promise<{ ok: true }> {
    const ownsAccount = await this.userOwnsAccount(stripeAccountId, userId)
    if (!ownsAccount) throw new NotFoundException('Stripe account not found')

    await this.backfillService.retryBackfill(stripeAccountId)
    this.logger.log(`  ✓ retryBackfill kicked off  account=${stripeAccountId}  user=${userId}`)
    return { ok: true }
  }

  async getAccountStatus(
    stripeAccountId: string,
    userId: string,
  ): Promise<StripeAccountStatus> {
    const ownsAccount = await this.userOwnsAccount(stripeAccountId, userId)
    if (!ownsAccount) throw new NotFoundException('Stripe account not found')

    const { data, error } = await this.stripeRepository.findAccountStatus(stripeAccountId)
    if (error) throw new Error(`stripe_accounts read: ${error.message}`)
    if (!data) throw new NotFoundException('Stripe account not found')

    return {
      stripeAccountId: data.id as string,
      backfillStatus:
        (data.backfill_status as StripeAccountStatus['backfillStatus']) ?? null,
      backfilledThrough: (data.backfilled_through as string | null) ?? null,
      lastSyncedAt: (data.last_synced_at as string | null) ?? null,
      backfillError: (data.backfill_error as string | null) ?? null,
    }
  }

  private credentialTableForType(connectionType: string): StripeCredentialTable | null {
    if (connectionType === 'stripe_manual') return 'connections_stripe_manual'
    if (connectionType === 'stripe') return 'connections_stripe'
    return null
  }

  private async getCredentialForConnection(
    connectionId: string,
    connectionType: string,
  ): Promise<{ stripeAccountId: string | null; trackedProductIds: string[] } | null> {
    const table = this.credentialTableForType(connectionType)
    if (!table) return null

    const { data } = await this.connectionsRepository.findCredentialContext(
      connectionId,
      table,
    )

    return {
      stripeAccountId: (data?.stripe_account_id as string | null) ?? null,
      trackedProductIds: (data?.tracked_product_ids as string[] | null) ?? [],
    }
  }

  private async userOwnsAccount(stripeAccountId: string, userId: string): Promise<boolean> {
    const [manualRes, oauthRes] =
      await this.connectionsRepository.findConnectionIdsByStripeAccount(stripeAccountId)

    const connectionIds = [
      ...((manualRes.data ?? []).map(r => r.connection_id as string)),
      ...((oauthRes.data ?? []).map(r => r.connection_id as string)),
    ]
    if (connectionIds.length === 0) return false

    const { data: ownConns, error } = await this.connectionsRepository.findAnyOwnedId(
      userId,
      connectionIds,
    )

    if (error) throw new Error(`connections ownership check: ${error.message}`)
    return (ownConns?.length ?? 0) > 0
  }
}
