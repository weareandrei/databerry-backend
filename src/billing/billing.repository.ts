import { Injectable } from '@nestjs/common'
import { SupabaseService } from '../supabase/supabase.service'

@Injectable()
export class BillingRepository {
  constructor(private readonly supabaseService: SupabaseService) {}

  // ── subscriptions ───────────────────────────────────────────

  async findPlanById(planId: string) {
    return this.supabaseService
      .getClient()
      .from('subscriptions')
      .select('id, name, stripe_price_id, stripe_intro_coupon_id')
      .eq('id', planId)
      .single()
  }

  async findPlanByStripePriceId(priceId: string) {
    return this.supabaseService
      .getClient()
      .from('subscriptions')
      .select('id')
      .eq('stripe_price_id', priceId)
      .single()
  }

  // ── accounts (billing fields) ─────────────────────────────────

  async findStripeCustomerId(userId: string) {
    return this.supabaseService
      .getClient()
      .from('accounts')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single()
  }

  async updateStripeCustomerId(userId: string, stripeCustomerId: string) {
    return this.supabaseService
      .getClient()
      .from('accounts')
      .update({ stripe_customer_id: stripeCustomerId })
      .eq('user_id', userId)
  }

  async findUserIdByStripeCustomerId(stripeCustomerId: string) {
    return this.supabaseService
      .getClient()
      .from('accounts')
      .select('user_id')
      .eq('stripe_customer_id', stripeCustomerId)
      .single()
  }

  async updateSubscription(
    userId: string,
    planId: string,
    stripeSubscriptionId: string,
  ) {
    return this.supabaseService
      .getClient()
      .from('accounts')
      .update({
        plan_id: planId,
        stripe_subscription_id: stripeSubscriptionId,
      })
      .eq('user_id', userId)
  }

  async revertToFree(userId: string) {
    return this.supabaseService
      .getClient()
      .from('accounts')
      .update({ plan_id: 'free', stripe_subscription_id: null })
      .eq('user_id', userId)
  }
}
