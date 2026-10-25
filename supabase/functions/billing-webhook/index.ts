import { createClient } from 'npm:@supabase/supabase-js@2.115.0'
import { z } from 'npm:zod@4.4.3'
import { BillingService } from '../_shared/billing/service.ts'
import { StripeGateway, verifyStripeSignature } from '../_shared/billing/stripe.ts'

const eventSchema = z.object({ id: z.string().regex(/^evt_/), type: z.string(), created: z.number().int(), livemode: z.literal(false), data: z.object({ object: z.object({ customer: z.string().optional() }).passthrough() }) })
Deno.serve(async request => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  try {
    const secret = Deno.env.get('STRIPE_TEST_WEBHOOK_SECRET') ?? ''
    const raw = await request.text()
    await verifyStripeSignature(raw, request.headers.get('stripe-signature'), secret)
    const event = eventSchema.parse(JSON.parse(raw))
    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    const service = new BillingService(db, new StripeGateway(Deno.env.get('STRIPE_TEST_SECRET_KEY') ?? ''), Deno.env.get('BILLING_APP_URL') ?? '', '')
    await service.processEvent(event)
    return Response.json({ received: true })
  } catch (error) {
    const invalid = error instanceof z.ZodError || (error instanceof Error && error.message === 'BILLING_INVALID_SIGNATURE')
    // Never include the event payload, invoice, signature, customer PII or Stripe response in logs.
    return Response.json({ error: invalid ? 'Invalid webhook' : 'Retry required' }, { status: invalid ? 400 : 503 })
  }
})
