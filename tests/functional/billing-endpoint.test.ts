import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { compileComponent } from '../helpers/component-harness.mjs'
import { billingErrorMessages } from '../../supabase/functions/_shared/billing/errors'
import { billingFailureDiagnostic } from '../../supabase/functions/_shared/billing/diagnostics'
import { billingSecretsStatus } from '../../supabase/functions/_shared/billing/env'
import type { BillingSecrets } from '../../supabase/functions/_shared/billing/env'

function endpoint(admin = true, role = 'owner', active = true, secretsStatus: (secrets: BillingSecrets) => unknown = secrets => ({ status: secrets })) {
  let handler: (request: Request) => Promise<Response>
  const log = vi.fn()
  const upsert = vi.fn(async (_row: object) => ({ error: null }))
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: 'admin' } } }) },
    from: () => ({ select() { return this }, eq() { return this }, single: async () => ({ data: { is_superadmin: admin } }), maybeSingle: async () => ({ data: { role, is_active: active } }), upsert }),
  }
  const operation = { id: 'operation', status: 'payment_pending', result: { url: 'https://www.mollie.com/checkout/private', paymentId: 'tr_test' } }
  const invoice = { number: 'INV-1', amount_due_cents: 5929, hosted_invoice_url: 'https://www.mollie.com/checkout/private-invoice', invoice_pdf: null }
  const portal = vi.fn(async () => ({ url: 'https://www.mollie.com/checkout/private-arrears' }))
  const confirm = vi.fn(async () => ({ operation, url: operation.result.url }))
  const quoteCancel = vi.fn(async () => ({ id: 'cancel' }))
  const changeMandate = vi.fn(async () => ({ mandateId: 'mdt_new', last4: '1332' }))
  const invoiceDocument = vi.fn(async () => ({ filename: 'INV-1.pdf', contentType: 'application/pdf', base64: 'JVBERg==' }))
  const saveProfile = vi.fn(async () => ({ saved: true }))
  const schemas = compileComponent(readFileSync(new URL('../../supabase/functions/_shared/billing/schemas.ts', import.meta.url), 'utf8'), { 'npm:zod@4.4.3': { z } })
  compileComponent(readFileSync(new URL('../../supabase/functions/billing/index.ts', import.meta.url), 'utf8'), {
    'npm:@supabase/supabase-js@2.115.0': { createClient: () => client },
    '../_shared/billing/errors.ts': { billingErrorMessages },
    '../_shared/billing/diagnostics.ts': { billingFailureDiagnostic },
    '../_shared/billing/schemas.ts': schemas,
    '../_shared/billing/env.ts': { billingEnv: () => ({ configured: true }), loadBillingSecrets: async () => ({ mollie_api_key: 'test_oldoldoldoldoldoldoldold', odoo_url: 'https://odoo.example.test', odoo_db: 'Alteil', odoo_api_key: 'old-odoo-key-0000' }), billingSecretsStatus: secretsStatus, billingServiceFromEnv: () => ({
      async quote() { throw new Error('BILLING_INVALID_PROMOTION_CONTRACT') },
      async detail() { return { operations: [operation], invoices: [invoice] } },
      confirm,
      portal,
      quoteCancel,
      changeMandate,
      invoiceDocument,
      saveProfile,
    }) },
  }, {
    Deno: { serve: (callback: typeof handler) => { handler = callback }, env: { get: () => 'https://staging.example.test' } },
    Response, Request, URL, Error, console: { error: log },
  })
  return { log, upsert, portal, confirm, quoteCancel, changeMandate, invoiceDocument, saveProfile, operation, invoice, send: (body: string) => handler(new Request('https://staging.example.test', { method: 'POST', body })) }
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

it('lets the owner cancel at the end of the paid period but keeps immediate cancellation for Superadmin', async () => {
  const owner = endpoint(false)
  expect((await owner.send(JSON.stringify({ action: 'quote-cancel', tenantId, immediate: false, reason: 'Baja solicitada por el cliente' }))).status).toBe(200)
  expect(owner.quoteCancel).toHaveBeenCalledWith(tenantId, 'admin', false, 'Baja solicitada por el cliente')
  expect((await owner.send(JSON.stringify({ action: 'quote-cancel', tenantId, immediate: true, reason: 'Ya' }))).status).toBe(403)
  expect(owner.quoteCancel).toHaveBeenCalledTimes(1)
  expect((await endpoint(false, 'manager').send(JSON.stringify({ action: 'quote-cancel', tenantId, immediate: false, reason: 'Baja' }))).status).toBe(403)
  const admin = endpoint()
  expect((await admin.send(JSON.stringify({ action: 'quote-cancel', tenantId, immediate: true, reason: 'Fraude' }))).status).toBe(200)
})

it('changes the direct-debit IBAN only for the owner', async () => {
  const body = JSON.stringify({ action: 'change-mandate', tenantId, requestId: tenantId, sepa: { accountHolder: 'Titular SL', iban: 'ES91 2100 0418 4502 0005 1332' } })
  const owner = endpoint(false)
  const response = await owner.send(body)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ mandateId: 'mdt_new', last4: '1332' })
  expect(owner.changeMandate).toHaveBeenCalledWith(tenantId, tenantId, { accountHolder: 'Titular SL', iban: 'ES91 2100 0418 4502 0005 1332' })
  const admin = endpoint()
  expect((await admin.send(body)).status).toBe(403)
  expect(admin.changeMandate).not.toHaveBeenCalled()
})

it('serves invoice documents to the owner and validates the payment id', async () => {
  const h = endpoint(false)
  const response = await h.send(JSON.stringify({ action: 'invoice-document', tenantId, paymentId: 'tr_abc123', document: 'main' }))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ filename: 'INV-1.pdf', contentType: 'application/pdf', base64: 'JVBERg==' })
  expect(h.invoiceDocument).toHaveBeenCalledWith(tenantId, 'tr_abc123', 'main')
  expect((await h.send(JSON.stringify({ action: 'invoice-document', tenantId, paymentId: '../etc', document: 'main' }))).status).toBe(400)
  expect((await h.send(JSON.stringify({ action: 'invoice-document', tenantId, paymentId: 'tr_abc123', document: 'other' }))).status).toBe(400)
})

it('denies invoice documents to non-owners of the tenant', async () => {
  const h = endpoint(false, 'manager')
  expect((await h.send(JSON.stringify({ action: 'invoice-document', tenantId, paymentId: 'tr_abc123', document: 'main' }))).status).toBe(403)
  expect(h.invoiceDocument).not.toHaveBeenCalled()
})

it('saves integration keys only for Superadmin, keeping omitted values and never echoing keys', async () => {
  const body = JSON.stringify({ action: 'integrations-save', mollieApiKey: 'live_newnewnewnewnewnewnewnew' })
  const owner = endpoint(false)
  expect((await owner.send(body)).status).toBe(403)
  expect(owner.upsert).not.toHaveBeenCalled()
  const admin = endpoint()
  const response = await admin.send(body)
  expect(response.status).toBe(200)
  const stored = { mollie_api_key: 'live_newnewnewnewnewnewnewnew', odoo_url: 'https://odoo.example.test', odoo_db: 'Alteil', odoo_api_key: 'old-odoo-key-0000' }
  expect(admin.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: true, updated_by: 'admin', ...stored }))
  expect(await response.json()).toEqual({ status: stored })
})

it.each([
  { mollieApiKey: 'sk_live_123' },
  { odooUrl: 'http://odoo.example.test' },
  { odooApiKey: 'short' },
])('rejects invalid integration settings %o', async changes => {
  const admin = endpoint()
  expect((await admin.send(JSON.stringify({ action: 'integrations-save', ...changes }))).status).toBe(400)
  expect(admin.upsert).not.toHaveBeenCalled()
})

it('shows the saved Odoo server address to Superadmin through the redacting reply', async () => {
  vi.stubGlobal('Deno', { env: { get: () => undefined } })
  try {
    const response = await endpoint(true, 'owner', true, billingSecretsStatus).send(JSON.stringify({ action: 'integrations' }))
    expect(response.status).toBe(200)
    const status = await response.json()
    expect(status.odoo).toMatchObject({ source: 'stored', serverUrl: 'https://odoo.example.test', db: 'Alteil', keyHint: '…0000' })
    expect(JSON.stringify(status)).not.toContain('old-odoo-key-0000')
  } finally { vi.unstubAllGlobals() }
})


const profile = { legalName: 'Empresa SL', taxId: 'B12345678', email: 'billing@example.test', address: { street: 'Calle Mayor 1', postalCode: '28001', city: 'Madrid', province: 'Madrid', countryCode: 'ES' } }
it.each([true, false])('allows an authorized owner/admin to save a complete fiscal profile (admin=%s)', async admin => {
  const h = endpoint(admin)
  expect((await h.send(JSON.stringify({ action: 'save-profile', tenantId, profile }))).status).toBe(200)
  expect(h.saveProfile).toHaveBeenCalledWith(tenantId, 'admin', profile)
})
it.each([['manager', true], ['owner', false], ['cashier', true]])('denies profile writes for role=%s active=%s', async (role, active) => {
  const h = endpoint(false, role, active)
  expect((await h.send(JSON.stringify({ action: 'save-profile', tenantId, profile }))).status).toBe(403)
  expect(h.saveProfile).not.toHaveBeenCalled()
})
it('rejects incomplete or malformed billing addresses before saving them', async () => {
  for (const address of [{ ...profile.address, street: '' }, { ...profile.address, countryCode: 'España' }]) {
    const h = endpoint(false)
    expect((await h.send(JSON.stringify({ action: 'save-profile', tenantId, profile: { ...profile, address } }))).status).toBe(400)
    expect(h.saveProfile).not.toHaveBeenCalled()
  }
})
