import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { MollieGateway } from './mollie.ts'
import { OdooGateway } from './odoo.ts'
import { BillingService } from './service.ts'

export type BillingSecrets = { mollie_api_key: string | null; odoo_url: string | null; odoo_db: string | null; odoo_api_key: string | null }
const noSecrets: BillingSecrets = { mollie_api_key: null, odoo_url: null, odoo_db: null, odoo_api_key: null }

// Keys saved from Superadmin win over the Edge env. Only a missing table (function deployed before
// its migration) falls back to env: any other DB error must not silently switch Mollie accounts.
export async function loadBillingSecrets(db: SupabaseClient): Promise<BillingSecrets> {
  const { data, error } = await db.from('platform_billing_secrets').select('mollie_api_key,odoo_url,odoo_db,odoo_api_key').eq('id', true).maybeSingle()
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return noSecrets
    throw new Error('BILLING_DB_SECRETS')
  }
  return data ?? noSecrets
}

// Mollie needs a public HTTPS webhook; inside self-hosted Edge Runtime SUPABASE_URL is internal.
export function billingEnv(secrets: BillingSecrets = noSecrets) {
  // MOLLIE_API_KEY (live_… for real charges); MOLLIE_TEST_API_KEY kept for existing sandbox setups.
  const mollieKey = secrets.mollie_api_key || Deno.env.get('MOLLIE_API_KEY') || Deno.env.get('MOLLIE_TEST_API_KEY') || ''
  const appUrl = Deno.env.get('BILLING_APP_URL')?.replace(/\/$/, '') ?? ''
  const webhookUrl = Deno.env.get('BILLING_WEBHOOK_URL') ?? ''
  return { mollieKey, appUrl, webhookUrl, configured: Boolean(mollieKey && appUrl && /^https:\/\//.test(webhookUrl)) }
}

// Optional: without url, database and key no document is sent to Odoo. Stored values are used as a whole set.
export function odooConfig(secrets: BillingSecrets = noSecrets) {
  if (secrets.odoo_url && secrets.odoo_db && secrets.odoo_api_key) return { url: secrets.odoo_url, db: secrets.odoo_db, key: secrets.odoo_api_key, source: 'stored' as const }
  const url = Deno.env.get('ODOO_URL') ?? '', db = Deno.env.get('ODOO_DB') ?? '', key = Deno.env.get('ODOO_API_KEY') ?? ''
  return url && db && key ? { url, db, key, source: 'env' as const } : null
}

export function odooFromEnv(secrets: BillingSecrets = noSecrets) {
  const config = odooConfig(secrets)
  return config ? new OdooGateway(config.url, config.db, config.key) : null
}

export async function billingServiceFromEnv(db: SupabaseClient, loaded?: BillingSecrets) {
  const secrets = loaded ?? await loadBillingSecrets(db)
  const env = billingEnv(secrets)
  if (!env.configured) throw new Error('BILLING_NOT_CONFIGURED')
  return new BillingService(db, new MollieGateway(env.mollieKey), env.appUrl, env.webhookUrl, odooFromEnv(secrets))
}

const hint = (value: string) => `…${value.slice(-4)}`

// What Superadmin may see: where each credential comes from, never the keys themselves.
export function billingSecretsStatus(secrets: BillingSecrets) {
  const env = billingEnv(secrets), odoo = odooConfig(secrets)
  return {
    mollie: {
      source: secrets.mollie_api_key ? 'stored' : env.mollieKey ? 'env' : 'missing',
      mode: env.mollieKey.startsWith('live_') ? 'live' : env.mollieKey.startsWith('test_') ? 'test' : null,
      keyHint: env.mollieKey ? hint(env.mollieKey) : null,
    },
    odoo: {
      source: odoo?.source ?? 'missing',
      // Not `url`: the billing reply strips `url` keys from Superadmin responses (Mollie checkout links).
      serverUrl: secrets.odoo_url ?? odoo?.url ?? null,
      db: secrets.odoo_db ?? odoo?.db ?? null,
      keyHint: secrets.odoo_api_key ? hint(secrets.odoo_api_key) : odoo ? hint(odoo.key) : null,
    },
    urlsConfigured: Boolean(env.appUrl && /^https:\/\//.test(env.webhookUrl)),
  }
}
