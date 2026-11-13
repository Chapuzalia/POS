import { createClient } from 'npm:@supabase/supabase-js@2.115.0'
import { billingServiceFromEnv } from '../_shared/billing/env.ts'

// Runs period-end changes, promotion amounts and cancellations that no webhook announces.
// A scheduler credential distinct from Supabase keys and never exposed to a browser.
Deno.serve(async request => {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const secret = Deno.env.get('BILLING_RECONCILE_SECRET') ?? ''
  const actual = request.headers.get('Authorization') ?? ''
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  const expectedHash = await digest(`Bearer ${secret}`), actualHash = await digest(actual)
  let difference = 0
  for (let index = 0; index < expectedHash.length; index++) difference |= expectedHash[index] ^ actualHash[index]
  if (secret.length < 32 || difference !== 0) return new Response(null, { status: 401 })
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
    const service = await billingServiceFromEnv(db)
    // Legacy Stripe sandbox links (cus_) are not reconciled through Mollie.
    const accounts = await db.from('billing_accounts').select('tenant_id').like('stripe_customer_id','cst_%').order('last_attempt_at',{nullsFirst:true}).limit(10)
    if (accounts.error) throw new Error('BILLING_DB_BATCH')
    let succeeded = 0, failed = 0
    for (const account of accounts.data) {
      try { const result = await service.reconcile(account.tenant_id); if (result.sepaWarning) failed++; else succeeded++ } catch { failed++ }
    }
    return Response.json({ succeeded, failed }, { status: failed ? 503 : 200 })
  } catch { return Response.json({ error: 'Reconciliation unavailable' }, { status: 503 }) }
})
