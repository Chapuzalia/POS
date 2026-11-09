import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { MollieGateway } from './mollie.ts'
import { BillingService } from './service.ts'

// Mollie needs a public HTTPS webhook; inside self-hosted Edge Runtime SUPABASE_URL is internal.
export function billingEnv() {
  // MOLLIE_API_KEY (live_… for real charges); MOLLIE_TEST_API_KEY kept for existing sandbox setups.
  const mollieKey = Deno.env.get('MOLLIE_API_KEY') || Deno.env.get('MOLLIE_TEST_API_KEY') || ''
  const appUrl = Deno.env.get('BILLING_APP_URL')?.replace(/\/$/, '') ?? ''
  const webhookUrl = Deno.env.get('BILLING_WEBHOOK_URL') ?? ''
  return { mollieKey, appUrl, webhookUrl, configured: Boolean(mollieKey && appUrl && /^https:\/\//.test(webhookUrl)) }
}

export function billingServiceFromEnv(db: SupabaseClient) {
  const env = billingEnv()
  if (!env.configured) throw new Error('BILLING_NOT_CONFIGURED')
  return new BillingService(db, new MollieGateway(env.mollieKey), env.appUrl, env.webhookUrl)
}
