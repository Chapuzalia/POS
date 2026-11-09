import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { MollieGateway } from './mollie.ts'
import { OdooGateway } from './odoo.ts'
import { BillingService } from './service.ts'

// Mollie needs a public HTTPS webhook; inside self-hosted Edge Runtime SUPABASE_URL is internal.
export function billingEnv() {
  // MOLLIE_API_KEY (live_… for real charges); MOLLIE_TEST_API_KEY kept for existing sandbox setups.
  const mollieKey = Deno.env.get('MOLLIE_API_KEY') || Deno.env.get('MOLLIE_TEST_API_KEY') || ''
  const appUrl = Deno.env.get('BILLING_APP_URL')?.replace(/\/$/, '') ?? ''
  const webhookUrl = Deno.env.get('BILLING_WEBHOOK_URL') ?? ''
  return { mollieKey, appUrl, webhookUrl, configured: Boolean(mollieKey && appUrl && /^https:\/\//.test(webhookUrl)) }
}

// Optional: without the three variables no document is sent to Odoo.
export function odooFromEnv() {
  const url = Deno.env.get('ODOO_URL') ?? '', db = Deno.env.get('ODOO_DB') ?? '', key = Deno.env.get('ODOO_API_KEY') ?? ''
  return url && db && key ? new OdooGateway(url, db, key) : null
}

export function billingServiceFromEnv(db: SupabaseClient) {
  const env = billingEnv()
  if (!env.configured) throw new Error('BILLING_NOT_CONFIGURED')
  return new BillingService(db, new MollieGateway(env.mollieKey), env.appUrl, env.webhookUrl, odooFromEnv())
}
