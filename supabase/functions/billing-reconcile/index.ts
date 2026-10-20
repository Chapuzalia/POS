import { createClient } from 'npm:@supabase/supabase-js@2.115.0'
import { BillingService } from '../_shared/billing/service.ts'
import { StripeGateway } from '../_shared/billing/stripe.ts'

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
    const service = new BillingService(db, new StripeGateway(Deno.env.get('STRIPE_TEST_SECRET_KEY') ?? ''), '', '')
    const accounts = await db.from('billing_accounts').select('tenant_id').not('stripe_customer_id','is',null).order('last_attempt_at',{nullsFirst:true}).limit(10)
    if (accounts.error) throw new Error('BILLING_DB_BATCH')
    let succeeded = 0, failed = 0
    for (const account of accounts.data) {
      try { await service.reconcile(account.tenant_id); succeeded++ } catch { failed++ }
    }
    return Response.json({ succeeded, failed }, { status: failed ? 503 : 200 })
  } catch { return Response.json({ error: 'Reconciliation unavailable' }, { status: 503 }) }
})
