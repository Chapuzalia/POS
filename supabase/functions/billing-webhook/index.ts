import { createClient } from 'npm:@supabase/supabase-js@2.115.0'
import { billingServiceFromEnv } from '../_shared/billing/env.ts'

// Mollie posts only `id=tr_…`, unsigned. Nothing in the body is trusted: the service
// re-reads the payment from the Mollie API and checks customer↔tenant before any change.
Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const raw = await request.text()
  const id = raw.length <= 200 ? new URLSearchParams(raw).get('id') : null
  if (!id || !/^tr_[A-Za-z0-9]{4,40}$/.test(id)) return new Response('Invalid webhook', { status: 400 })
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
    await (await billingServiceFromEnv(db)).handleWebhook(id)
    return new Response(null, { status: 200 })
  } catch {
    // Non-2xx makes Mollie retry. Never log the payment, customer or Mollie response.
    return new Response('Retry required', { status: 503 })
  }
})
