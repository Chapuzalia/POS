import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { compileComponent } from '../helpers/component-harness.mjs'
import { billingErrorMessages } from '../../supabase/functions/_shared/billing/errors'
import { billingFailureDiagnostic } from '../../supabase/functions/_shared/billing/diagnostics'
import { StripeGateway } from '../../supabase/functions/_shared/billing/stripe'

function endpoint() {
  let handler: (request: Request) => Promise<Response>
  const log = vi.fn()
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'admin' } } }) },
    from: () => ({ select() { return this }, eq() { return this }, single: async () => ({ data: { is_superadmin: true } }) }),
  }
  const schemas = compileComponent(readFileSync(new URL('../../supabase/functions/_shared/billing/schemas.ts', import.meta.url), 'utf8'), { 'npm:zod@4.4.3': { z } })
  compileComponent(readFileSync(new URL('../../supabase/functions/billing/index.ts', import.meta.url), 'utf8'), {
    'npm:@supabase/supabase-js@2.115.0': { createClient: () => client },
    '../_shared/billing/errors.ts': { billingErrorMessages },
    '../_shared/billing/diagnostics.ts': { billingFailureDiagnostic },
    '../_shared/billing/stripe.ts': { StripeGateway },
    '../_shared/billing/schemas.ts': schemas,
    '../_shared/billing/service.ts': { BillingService: class { async quote() { throw new Error('BILLING_INVALID_PROMOTION_CONTRACT') } } },
  }, {
    Deno: { serve: (callback: typeof handler) => { handler = callback }, env: { get: (name: string) => name === 'STRIPE_TEST_SECRET_KEY' ? 'sk_test_fixture' : 'https://staging.example.test' } },
    Response, Request, URL, Error, console: { error: log },
  })
  return { log, send: (body: string) => handler(new Request('https://staging.example.test', { method: 'POST', body })) }
}

it.each(['{"action":"quote","reason":"private customer text"}', 'not JSON private token'])('returns a reviewed validation error and logs no invalid request contents', async body => {
  const h = endpoint()
  const response = await h.send(body)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ code: 'BILLING_INVALID_REQUEST', error: billingErrorMessages.BILLING_INVALID_REQUEST })
  expect(JSON.parse(h.log.mock.calls[0][0])).toEqual({ event: 'billing_request_failed', action: 'unvalidated', code: 'BILLING_INVALID_REQUEST' })
})

it('identifies a failed action without logging its commercial request', async () => {
  const h = endpoint()
  const id = '11111111-1111-4111-8111-111111111111'
  const response = await h.send(JSON.stringify({ action: 'quote', tenantId: id, selection: { planVersionId: id, addons: [] }, exception: null, reason: 'Private commercial agreement' }))
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ code: 'BILLING_INVALID_PROMOTION_CONTRACT', error: billingErrorMessages.BILLING_INVALID_PROMOTION_CONTRACT })
  expect(JSON.parse(h.log.mock.calls[0][0])).toEqual({ event: 'billing_request_failed', action: 'quote', code: 'BILLING_INVALID_PROMOTION_CONTRACT' })
})
