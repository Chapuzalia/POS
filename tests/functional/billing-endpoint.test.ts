import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { compileComponent } from '../helpers/component-harness.mjs'
import { billingErrorMessages } from '../../supabase/functions/_shared/billing/errors'
import { billingFailureDiagnostic } from '../../supabase/functions/_shared/billing/diagnostics'

function endpoint(admin = true, role = 'owner', active = true) {
  let handler: (request: Request) => Promise<Response>
  const log = vi.fn()
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'admin' } } }) },
    from: () => ({ select() { return this }, eq() { return this }, single: async () => ({ data: { is_superadmin: admin } }), maybeSingle: async () => ({ data: { role, is_active: active } }) }),
  }
  const operation = { id: 'operation', status: 'payment_pending', result: { url: 'https://www.mollie.com/checkout/private', paymentId: 'tr_test' } }
  const invoice = { number: 'INV-1', amount_due_cents: 5929, hosted_invoice_url: 'https://www.mollie.com/checkout/private-invoice', invoice_pdf: null }
  const portal = vi.fn(async () => ({ url: 'https://www.mollie.com/checkout/private-arrears' }))
  const confirm = vi.fn(async () => ({ operation, url: operation.result.url }))
  const schemas = compileComponent(readFileSync(new URL('../../supabase/functions/_shared/billing/schemas.ts', import.meta.url), 'utf8'), { 'npm:zod@4.4.3': { z } })
  compileComponent(readFileSync(new URL('../../supabase/functions/billing/index.ts', import.meta.url), 'utf8'), {
    'npm:@supabase/supabase-js@2.115.0': { createClient: () => client },
    '../_shared/billing/errors.ts': { billingErrorMessages },
    '../_shared/billing/diagnostics.ts': { billingFailureDiagnostic },
    '../_shared/billing/schemas.ts': schemas,
    '../_shared/billing/env.ts': { billingEnv: () => ({ configured: true }), billingServiceFromEnv: () => ({
      async quote() { throw new Error('BILLING_INVALID_PROMOTION_CONTRACT') },
      async detail() { return { operations: [operation], invoices: [invoice] } },
      confirm,
      portal,
    }) },
  }, {
    Deno: { serve: (callback: typeof handler) => { handler = callback }, env: { get: () => 'https://staging.example.test' } },
    Response, Request, URL, Error, console: { error: log },
  })
  return { log, portal, confirm, operation, invoice, send: (body: string) => handler(new Request('https://staging.example.test', { method: 'POST', body })) }
}

const tenantId = '11111111-1111-4111-8111-111111111111'

it('denies superadmin access to the customer payment portal before creating a session', async () => {
  const h = endpoint()
  expect((await h.send(JSON.stringify({ action: 'portal', tenantId }))).status).toBe(403)
  expect(h.portal).not.toHaveBeenCalled()
})

it.each([true, false])('returns payment and invoice links only to the customer (admin=%s)', async admin => {
  const h = endpoint(admin)
  const response = await h.send(JSON.stringify({ action: 'get', tenantId }))
  expect(response.status).toBe(200)
  const detail = await response.json()
  expect(detail.operations[0].result).toEqual(admin ? { paymentId: 'tr_test' } : h.operation.result)
  expect(detail.invoices[0]).toEqual(admin ? { number: 'INV-1', amount_due_cents: 5929 } : h.invoice)
})

it.each(['confirm', 'retry-operation'])('keeps admin %s available without returning payment links', async action => {
  const h = endpoint()
  const response = await h.send(JSON.stringify({ action, tenantId, operationId: tenantId }))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ operation: { ...h.operation, result: { paymentId: 'tr_test' } } })
})

it('allows the owner to open the portal and continue their confirmed payment', async () => {
  const h = endpoint(false)
  const portal = await h.send(JSON.stringify({ action: 'portal', tenantId }))
  expect(portal.status).toBe(200)
  expect(await portal.json()).toEqual({ url: 'https://www.mollie.com/checkout/private-arrears' })
  const confirmed = await h.send(JSON.stringify({ action: 'confirm', tenantId, operationId: tenantId }))
  expect(await confirmed.json()).toEqual({ operation: h.operation, url: h.operation.result.url })
})

it.each([['manager', true], ['owner', false]] as const)('denies billing links to %s with active=%s', async (role, active) => {
  const h = endpoint(false, role, active)
  for (const action of ['portal', 'get']) expect((await h.send(JSON.stringify({ action, tenantId }))).status).toBe(403)
  expect(h.portal).not.toHaveBeenCalled()
})

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

it('forwards the owner SEPA authorization and refuses it from Superadmin', async () => {
  const sepa = { accountHolder: 'Restaurante Prueba SL', iban: 'ES9121000418450200051332' }
  const payer = { legalName: 'Restaurante Prueba SL', taxId: 'B12345678' }
  const owner = endpoint(false)
  expect((await owner.send(JSON.stringify({ action: 'confirm', tenantId, operationId: tenantId, sepa, payer }))).status).toBe(200)
  expect(owner.confirm).toHaveBeenCalledWith(tenantId, 'admin', tenantId, false, { sepa, payer })
  const admin = endpoint()
  expect((await admin.send(JSON.stringify({ action: 'confirm', tenantId, operationId: tenantId, sepa }))).status).toBe(403)
  expect(admin.confirm).not.toHaveBeenCalled()
  // The IBAN never reaches the failure log.
  await owner.send(JSON.stringify({ action: 'confirm', tenantId, operationId: tenantId, sepa: { ...sepa, extra: 1 } }))
  expect(JSON.stringify(owner.log.mock.calls)).not.toContain('ES91')
})
