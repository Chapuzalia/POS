import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { FakeOdoo, createBillingService, payer, sepa } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'
import { grossCents, netFromGross } from '../../supabase/functions/_shared/billing/mollie'
import { odooVat } from '../../supabase/functions/_shared/billing/odoo-sync'

afterEach(() => { vi.useRealTimers() })

async function setup(options = {}) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T10:00:00Z'))
  return createBillingService({ after: onTestFinished }, 4900, options)
}

type Row = Record<string, unknown>
async function odooSetup() {
  const odoo = new FakeOdoo()
  const fixture = await setup({ odoo })
  const invoice = async (id: string) => (await fixture.db.query('select * from billing_invoices where stripe_invoice_id=$1', [id])).rows[0] as Row
  const doc = async (id: string) => (await fixture.db.query('select * from billing_odoo_documents where payment_id=$1', [id])).rows[0] as Row | undefined
  const count = async (where = 'true') => ((await fixture.db.query(`select count(*)::int n from billing_odoo_documents where ${where}`)).rows[0] as { n: number }).n
  const start = async () => {
    const quote = await fixture.service.quote(ids.tenant, ids.owner, fixture.selection, null, 'Alta')
    await fixture.service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer })
    return fixture.mollie.payment('first')
  }
  return { ...fixture, odoo, invoice, doc, count, start }
}

it('keeps Odoo documents private to the service role', async () => {
  const { db, activate } = await setup()
  await activate()
  const [{ stripe_invoice_id: paymentId }] = (await db.query('select stripe_invoice_id from billing_invoices')).rows as { stripe_invoice_id: string }[]
  await expect(db.query(`insert into billing_odoo_documents(payment_id, tenant_id, state) values ($1, $2, 'bogus')`, [paymentId, ids.tenant])).rejects.toThrow(/check/)
  await db.query(`insert into billing_odoo_documents(payment_id, tenant_id, state) values ($1, $2, 'proforma')`, [paymentId, ids.tenant])
  // Supabase grants table privileges to authenticated by default; RLS must still hide every row.
  await db.exec(`grant select, insert, update on billing_odoo_documents to authenticated; set test.uid = '${ids.owner}'; set role authenticated`)
  try {
    expect((await db.query('select * from billing_odoo_documents')).rows).toEqual([])
    await expect(db.query(`update billing_odoo_documents set state = 'invoiced'`)).resolves.toMatchObject({ affectedRows: 0 })
    await expect(db.query(`insert into billing_odoo_documents(payment_id, tenant_id, state) values ($1, $2, 'proforma')`, [paymentId, ids.tenant])).rejects.toThrow(/row-level security/)
    await expect(db.query('select odoo_partner_id from billing_accounts')).resolves.toBeTruthy()
  } finally { await db.exec('reset role') }
})

it('creates a proforma while the first card payment is open', async () => {
  const { service, odoo, start, invoice, doc } = await odooSetup()
  const payment = await start()
  await service.reconcile(ids.tenant)
  expect(odoo.orders).toHaveLength(1)
  expect(odoo.orders[0]).toMatchObject({ client_order_ref: payment.id, origin: 'Tickit test', state: 'draft', lines: [{ product_id: 501, product_uom_qty: 1, price_unit: 49 }] })
  expect(odoo.partners).toEqual([expect.objectContaining({ name: payer.legalName, vat: 'ESB12345678', is_company: true, country_id: 68 })])
  expect(odoo.partners[0]).toMatchObject({ ref: `tickit:${ids.tenant}`, email: payer.email, street: payer.address.street, zip: payer.address.postalCode, city: payer.address.city, state_id: 701 })
  expect(await doc(payment.id)).toMatchObject({ state: 'proforma', sale_order_id: odoo.orders[0].id, invoice_id: null })
  expect(await invoice(payment.id)).toMatchObject({ fiscal_export_status: 'pending_review', number: null, fiscal_external_reference: `sale.order:${odoo.orders[0].id}` })
  expect(odoo.moves).toHaveLength(0)
})

it('posts and pays the invoice when the payment settles', async () => {
  const { service, mollie, odoo, start, invoice, doc } = await odooSetup()
  const payment = await start()
  await service.reconcile(ids.tenant)
  mollie.payFirst()
  await service.reconcile(ids.tenant)
  expect(odoo.orders[0].state).toBe('sale')
  const [move] = odoo.moves
  expect(move).toMatchObject({ move_type: 'out_invoice', state: 'posted', amount_total: 59.29, payment_state: 'paid', name: 'INV/2026/00001' })
  expect(move.payment).toMatchObject({ journal_id: 601, payment_date: '2026-11-10', communication: payment.id })
  expect(await doc(payment.id)).toMatchObject({ state: 'invoiced', invoice_id: move.id, invoice_number: 'INV/2026/00001', last_error: null })
  expect(await invoice(payment.id)).toMatchObject({ fiscal_export_status: 'exported', number: 'INV/2026/00001', fiscal_external_reference: `account.move:${move.id}` })
})

it('invoices a SEPA renewal only after it settles', async () => {
  const { service, mollie, odoo, activate, doc } = await odooSetup()
  await activate()
  const renewal = mollie.renew('pending')
  await service.reconcile(ids.tenant)
  expect(await doc(renewal.id)).toMatchObject({ state: 'proforma' })
  expect(odoo.moves).toHaveLength(1)
  mollie.settle(renewal)
  await service.reconcile(ids.tenant)
  expect(await doc(renewal.id)).toMatchObject({ state: 'invoiced', invoice_number: 'INV/2026/00002' })
})

it('cancels the proforma when the payment expires', async () => {
  const { service, mollie, odoo, start, doc, invoice } = await odooSetup()
  const payment = await start()
  await service.reconcile(ids.tenant)
  mollie.payFirst('expired')
  await service.reconcile(ids.tenant)
  expect(odoo.orders[0].state).toBe('cancel')
  expect(odoo.moves).toHaveLength(0)
  expect(await doc(payment.id)).toMatchObject({ state: 'canceled' })
  expect(await invoice(payment.id)).toMatchObject({ fiscal_export_status: 'pending_review', number: null })
})

it('issues a credit note when a settled payment is charged back', async () => {
  const { service, mollie, odoo, activate, doc, invoice } = await odooSetup()
  await activate()
  const paid = mollie.payment('first')
  mollie.chargeBack(paid)
  await service.reconcile(ids.tenant)
  const refund = odoo.moves.find(move => move.move_type === 'out_refund')
  expect(refund).toMatchObject({ state: 'posted', reversed_entry_id: odoo.moves[0].id, name: 'RINV/2026/00002' })
  expect(await doc(paid.id)).toMatchObject({ state: 'refunded', refund_id: refund?.id, invoice_number: 'INV/2026/00001' })
  expect(await invoice(paid.id)).toMatchObject({ fiscal_export_status: 'exported', number: 'INV/2026/00001' })
})

it('invoices then refunds a charge-back that was never invoiced', async () => {
  const { service, mollie, odoo, activate, doc } = await odooSetup()
  odoo.offline = true
  await activate()
  const paid = mollie.payment('first')
  expect(await doc(paid.id)).toMatchObject({ state: 'failed', last_error: 'ODOO_UNAVAILABLE' })
  odoo.offline = false
  mollie.chargeBack(paid)
  await service.reconcile(ids.tenant)
  expect(odoo.moves.map(move => [move.move_type, move.state])).toEqual([['out_invoice', 'posted'], ['out_refund', 'posted']])
  expect(await doc(paid.id)).toMatchObject({ state: 'refunded', last_error: null })
})

it('never duplicates documents across retries and concurrent reconciles', async () => {
  const { service, odoo, activate } = await odooSetup()
  await activate()
  await Promise.allSettled([service.reconcile(ids.tenant), service.reconcile(ids.tenant)])
  await service.reconcile(ids.tenant)
  expect(odoo.orders).toHaveLength(1)
  expect(odoo.moves).toHaveLength(1)
  expect(odoo.creates('account.payment.register')).toBe(1)
  expect(odoo.partners).toHaveLength(1)
})

it('refuses to post when Odoo total differs from Mollie', async () => {
  const { service, mollie, odoo, start, doc, invoice } = await odooSetup()
  odoo.totalOffsetCents = 1
  const payment = await start()
  mollie.payFirst()
  await service.reconcile(ids.tenant)
  expect(odoo.moves[0]).toMatchObject({ state: 'draft', name: '/' })
  expect(await doc(payment.id)).toMatchObject({ state: 'failed', last_error: 'ODOO_TOTAL_MISMATCH' })
  expect(await invoice(payment.id)).toMatchObject({ fiscal_export_status: 'failed', number: null })
})

it('keeps billing access unchanged when Odoo is down', async () => {
  const { service, mollie, odoo, activate, doc } = await odooSetup()
  odoo.offline = true
  await activate()
  const paymentId = mollie.payment('first').id
  const before = (await doc(paymentId))?.attempts as number
  await expect(service.reconcile(ids.tenant)).resolves.toEqual({ reconciled: true, discrepancy: null })
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'active', last_payment_status: 'paid' })
  expect(before).toBeGreaterThan(0)
  expect(await doc(paymentId)).toMatchObject({ state: 'failed', last_error: 'ODOO_UNAVAILABLE', attempts: before + 1 })
})

it('sends nothing when Odoo is not configured', async () => {
  const { service, db, activate } = await setup()
  await activate()
  await expect(service.reconcile(ids.tenant)).resolves.toEqual({ reconciled: true, discrepancy: null })
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'active', last_payment_status: 'paid' })
  expect((await db.query('select count(*)::int n from billing_odoo_documents')).rows[0]).toEqual({ n: 0 })
})

it('fails without partner data and creates nothing', async () => {
  const { service, odoo, db, mollie, activate, doc } = await odooSetup()
  odoo.offline = true
  await activate()
  odoo.offline = false
  await db.query(`update billing_invoices set customer_snapshot=customer_snapshot-'name' where tenant_id=$1`, [ids.tenant])
  odoo.calls.length = 0
  await service.reconcile(ids.tenant)
  expect(odoo.calls.filter(call => call.method === 'create')).toEqual([])
  expect(await doc(mollie.payment('first').id)).toMatchObject({ state: 'failed', last_error: 'ODOO_PARTNER_INVALID' })
})

it('does not overwrite fiscal fields when payments are re-upserted', async () => {
  const { service, mollie, activate, invoice } = await odooSetup()
  await activate()
  const paid = mollie.payment('first')
  await service.reconcile(ids.tenant)
  await service.reconcile(ids.tenant)
  expect(await invoice(paid.id)).toMatchObject({ fiscal_export_status: 'exported', number: 'INV/2026/00001' })
})

it('processes at most 10 payments per run', async () => {
  const { service, mollie, odoo, activate, count } = await odooSetup()
  odoo.offline = true
  await activate()
  for (let i = 0; i < 11; i++) mollie.renew('pending')
  await service.reconcile(ids.tenant)
  odoo.offline = false
  await service.reconcile(ids.tenant)
  expect(await count(`state <> 'failed'`)).toBe(10)
  await service.reconcile(ids.tenant)
  expect(await count(`state <> 'failed'`)).toBe(12)
})

it('round-trips VAT for every net amount', () => {
  for (let net = 1; net <= 200_000; net++) {
    if (grossCents(netFromGross(grossCents(net))) !== grossCents(net)) throw new Error(`VAT round-trip breaks at ${net}`)
  }
})

it('prefixes Spanish tax ids and keeps foreign VAT numbers', () => {
  expect(odooVat('b-1234567.8')).toBe('ESB12345678')
  expect(odooVat('X1234567L')).toBe('ESX1234567L')
  expect(odooVat('ESB12345678')).toBe('ESB12345678')
  expect(odooVat('FR12345678901')).toBe('FR12345678901')
})

it('creates no proforma for a payment that expired before Odoo saw it', async () => {
  const { service, mollie, odoo, start, doc } = await odooSetup()
  odoo.offline = true
  const payment = await start()
  await service.reconcile(ids.tenant)
  odoo.offline = false
  mollie.payFirst('expired')
  await service.reconcile(ids.tenant)
  expect(odoo.orders).toHaveLength(0)
  expect(await doc(payment.id)).toMatchObject({ state: 'canceled', sale_order_id: null })
})

const pdfText = (result: { base64: string }) => new TextDecoder().decode(Uint8Array.from(atob(result.base64), char => char.charCodeAt(0)))

it('serves the invoice PDF of the own tenant only', async () => {
  const { service, mollie, odoo, activate } = await odooSetup()
  await activate()
  const paid = mollie.payment('first')
  const result = await service.invoiceDocument(ids.tenant, paid.id, 'main')
  expect(result).toMatchObject({ filename: 'INV-2026-00001.pdf', contentType: 'application/pdf' })
  expect(pdfText(result)).toBe(`%PDF-1.7 /my/invoices/${odoo.moves[0].id}?access_token=tok${odoo.moves[0].id}&report_type=pdf&download=true`)
  await expect(service.invoiceDocument(ids.other, paid.id, 'main')).rejects.toThrow('BILLING_DOCUMENT_UNAVAILABLE')
  await expect(service.invoiceDocument(ids.tenant, paid.id, 'refund')).rejects.toThrow('BILLING_DOCUMENT_UNAVAILABLE')
})

it('serves the proforma before settlement and the refund after charge-back', async () => {
  const { service, mollie, odoo, start } = await odooSetup()
  const payment = await start()
  const proforma = await service.invoiceDocument(ids.tenant, payment.id, 'main')
  expect(proforma.filename).toBe(`Proforma-${payment.id}.pdf`)
  expect(pdfText(proforma)).toContain(`/my/orders/${odoo.orders[0].id}?`)
  mollie.payFirst()
  mollie.chargeBack(payment)
  await service.reconcile(ids.tenant)
  const refund = await service.invoiceDocument(ids.tenant, payment.id, 'refund')
  expect(refund.filename).toBe('RINV-2026-00002.pdf')
})

it('exposes odoo_state and has_refund in detail', async () => {
  const { service, mollie, activate } = await odooSetup()
  await activate()
  const paid = mollie.payment('first')
  mollie.chargeBack(paid)
  await service.reconcile(ids.tenant)
  const renewal = mollie.renew('pending')
  await service.reconcile(ids.tenant)
  const { invoices } = await service.detail(ids.tenant, false)
  expect(invoices.find((row: Row) => row.stripe_invoice_id === paid.id)).toMatchObject({ odoo_state: 'refunded', has_refund: true })
  expect(invoices.find((row: Row) => row.stripe_invoice_id === renewal.id)).toMatchObject({ odoo_state: 'proforma', has_refund: false })
})

it('reports Odoo status and failed documents in overview', async () => {
  const plain = await setup()
  await plain.activate()
  expect((await plain.service.overview()).odoo).toEqual({ enabled: false, failed: 0 })
  const { service, odoo, activate } = await odooSetup()
  odoo.offline = true
  await activate()
  expect((await service.overview()).odoo).toEqual({ enabled: true, failed: 1 })
})

it('stops calling a slow Odoo well inside the sync claim and resumes on the next run', async () => {
  const { service, mollie, odoo, db, activate, count } = await odooSetup()
  odoo.offline = true
  await activate()
  for (let i = 0; i < 4; i++) mollie.renew('pending')
  await service.reconcile(ids.tenant)
  const failedBefore = await count(`state = 'failed'`)
  const attempts = async () => ((await db.query('select coalesce(sum(attempts),0)::int n from billing_odoo_documents')).rows[0] as { n: number }).n
  const attemptsBefore = await attempts()
  odoo.offline = false
  odoo.onCall = () => { vi.setSystemTime(Date.now() + 3_000) }
  const startedAt = Date.now()
  await expect(service.reconcile(ids.tenant)).resolves.toEqual({ reconciled: true, discrepancy: null })
  expect(Date.now() - startedAt).toBeLessThanOrEqual(60_000)
  // Some payments advanced; the ones the budget did not reach are left untouched, not counted as failures.
  expect(await count(`state = 'failed'`)).toBeLessThan(failedBefore)
  expect(await count(`state = 'failed'`)).toBeGreaterThan(0)
  expect(await attempts()).toBe(attemptsBefore)
  odoo.onCall = undefined
  await service.reconcile(ids.tenant)
  expect(await count(`state = 'failed'`)).toBe(0)
})

it('keeps the credit note when a charge-back is reversed', async () => {
  const { service, mollie, odoo, activate, doc } = await odooSetup()
  await activate()
  const paid = mollie.payment('first')
  mollie.chargeBack(paid)
  await service.reconcile(ids.tenant)
  const refunded = await doc(paid.id)
  mollie.payments.find(row => row.id === paid.id).amountChargedBack = null
  await service.reconcile(ids.tenant)
  expect(await doc(paid.id)).toMatchObject({ state: 'refunded', refund_id: refunded?.refund_id })
  expect(odoo.moves.filter(move => move.move_type === 'out_refund')).toHaveLength(1)
})

it('cancels a proforma that was confirmed in Odoo without opening the cancel wizard', async () => {
  const { service, mollie, odoo, start, doc } = await odooSetup()
  const payment = await start()
  odoo.orders[0].state = 'sale'
  mollie.payFirst('expired')
  await service.reconcile(ids.tenant)
  expect(odoo.orders[0].state).toBe('cancel')
  expect(await doc(payment.id)).toMatchObject({ state: 'canceled' })
})

it('does not let repeatedly failing payments starve newer ones', async () => {
  const { service, mollie, odoo, activate, doc, count } = await odooSetup()
  odoo.offline = true
  await activate()
  odoo.offline = false
  // The first invoice never matches Mollie: it fails on every run (proformas are unaffected by the offset).
  odoo.totalOffsetCents = 1
  await service.reconcile(ids.tenant)
  await service.reconcile(ids.tenant)
  const stuck = mollie.payment('first').id
  vi.setSystemTime(new Date('2026-12-10T10:00:00Z'))
  for (let i = 0; i < 10; i++) mollie.renew('pending')
  odoo.offline = true
  await service.reconcile(ids.tenant)
  odoo.offline = false
  await service.reconcile(ids.tenant)
  expect(await count(`state = 'proforma'`)).toBe(10)
  expect(await doc(stuck)).toMatchObject({ state: 'failed' })
})

it('flags a partial charge-back for review instead of refunding the whole invoice', async () => {
  const { service, mollie, odoo, activate, doc } = await odooSetup()
  await activate()
  const paid = mollie.payment('first')
  mollie.payments.find(row => row.id === paid.id).amountChargedBack = { currency: 'EUR', value: '20.00' }
  await service.reconcile(ids.tenant)
  expect(odoo.moves.filter(move => move.move_type === 'out_refund')).toHaveLength(0)
  expect(await doc(paid.id)).toMatchObject({ state: 'failed', last_error: 'ODOO_REVIEW_REQUIRED', invoice_number: 'INV/2026/00001' })
})

it('stores the official invoice PDF without emailing anyone', async () => {
  const { mollie, odoo, activate } = await odooSetup()
  await activate()
  const [invoice] = odoo.moves
  expect(invoice).toMatchObject({ state: 'posted', is_move_sent: true, invoice_pdf_report_id: [expect.any(Number), 'INV_2026_00001.pdf'] })
  expect(odoo.emails).toEqual([])
  const writes = odoo.calls.filter(call => call.model === 'account.move.send.wizard' && call.method === 'write')
  expect(writes.at(-1)?.params.vals.sending_method_checkboxes).toEqual({ email: { label: 'by Email', checked: false }, snailmail: { label: 'by Post', checked: false } })
  expect(mollie.payment('first').status).toBe('paid')
})

it('stores the official PDF of the credit note too', async () => {
  const { service, mollie, odoo, activate } = await odooSetup()
  await activate()
  mollie.chargeBack(mollie.payment('first'))
  await service.reconcile(ids.tenant)
  expect(odoo.moves.find(move => move.move_type === 'out_refund')).toMatchObject({ state: 'posted', invoice_pdf_report_id: [expect.any(Number), 'RINV_2026_00002.pdf'] })
  expect(odoo.emails).toEqual([])
})

it('creates the missing official PDF before serving an invoice download', async () => {
  const { service, mollie, odoo, activate } = await odooSetup()
  await activate()
  const [invoice] = odoo.moves
  invoice.invoice_pdf_report_id = false
  invoice.is_move_sent = false
  odoo.calls.length = 0
  await service.invoiceDocument(ids.tenant, mollie.payment('first').id, 'main')
  const order = odoo.calls.map(call => call.pdf ? 'pdf' : `${call.model}.${call.method}`)
  expect(order.indexOf('account.move.send.wizard.action_send_and_print')).toBeGreaterThan(-1)
  expect(order.indexOf('account.move.send.wizard.action_send_and_print')).toBeLessThan(order.indexOf('account.move.get_portal_url'))
  expect(invoice.invoice_pdf_report_id).toBeTruthy()
  expect(odoo.emails).toEqual([])
})

it('never runs Send & Print while a sending method stays checked', async () => {
  const { odoo, mollie, activate, doc } = await odooSetup()
  odoo.stickyEmail = true
  await activate()
  expect(odoo.calls.some(call => call.method === 'action_send_and_print')).toBe(false)
  expect(odoo.emails).toEqual([])
  expect(odoo.moves[0]).toMatchObject({ state: 'posted', payment_state: 'paid', invoice_pdf_report_id: false })
  expect(await doc(mollie.payment('first').id)).toMatchObject({ state: 'failed', last_error: 'ODOO_REJECTED' })
})


it('does not reuse a cached or VAT-matching contact from another tenant', async () => {
  const { service, odoo, db, start } = await odooSetup()
  odoo.partners.push({ id: 999, ref: 'tickit:' + ids.other, name: payer.legalName, vat: 'ESB12345678', is_company: true, country_id: 68, state_id: 701, email: payer.email, street: payer.address.street, zip: payer.address.postalCode, city: payer.address.city })
  await service.account(ids.tenant)
  await db.query('update billing_accounts set odoo_partner_id=999 where tenant_id=$1', [ids.tenant])
  await start()
  await service.reconcile(ids.tenant)
  expect(odoo.partners).toHaveLength(2)
  expect(odoo.orders[0].partner_id).not.toBe(999)
  expect(odoo.partners[1]).toMatchObject({ ref: 'tickit:' + ids.tenant, name: payer.legalName })
})

it('uses the new fiscal profile on renewal without rewriting the first invoice or contact', async () => {
  const { service, odoo, mollie, activate, invoice } = await odooSetup()
  await activate()
  const first = mollie.payment('first')
  const oldSnapshot = (await invoice(first.id)).customer_snapshot
  const originalPartner = structuredClone(odoo.partners[0])
  const next = { ...payer, legalName: 'Nueva Empresa SL', email: 'new@example.test', address: { ...payer.address, street: 'Calle Nueva 2' } }
  await service.saveProfile(ids.tenant, ids.owner, next)
  const renewal = mollie.renew('paid')
  await service.reconcile(ids.tenant)
  expect((await invoice(first.id)).customer_snapshot).toEqual(oldSnapshot)
  expect((await invoice(renewal.id)).customer_snapshot).toMatchObject({ name: next.legalName, email: next.email, address: next.address })
  expect(odoo.partners[0]).toEqual(originalPartner)
  expect(odoo.partners).toHaveLength(2)
  expect(odoo.partners[1]).toMatchObject({ name: next.legalName, street: next.address.street, email: next.email })
  expect(odoo.moves[0].partner_id).toBe(originalPartner.id)
  expect(odoo.moves[1].partner_id).toBe(odoo.partners[1].id)
})

it('accepts an N-1 signup but refuses to issue an invoice with an incomplete fiscal snapshot', async () => {
  const { service, odoo, mollie, selection, doc } = await odooSetup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta N-1')
  await service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer: { legalName: payer.legalName, taxId: payer.taxId } })
  const payment = mollie.payFirst()
  await service.reconcile(ids.tenant)
  expect((await service.account(ids.tenant)).status).toBe('active')
  expect(await doc(payment.id)).toMatchObject({ state: 'failed', last_error: 'ODOO_PARTNER_INVALID' })
  expect(odoo.moves).toHaveLength(0)
})

it('reserves direct profile writes to the service role and audits them atomically', async () => {
  const { service, db } = await odooSetup()
  await service.account(ids.tenant)
  await service.saveProfile(ids.tenant, ids.owner, payer)
  expect(await service.account(ids.tenant)).toMatchObject({ legal_name: payer.legalName, email: payer.email, billing_address: payer.address })
  expect((await db.query("select action from billing_audit where tenant_id=$1 and action='profile'", [ids.tenant])).rows).toHaveLength(1)
  await service.saveProfile(ids.tenant, ids.owner, { legalName: 'Otra Empresa SL', taxId: payer.taxId })
  expect((await service.account(ids.tenant)).billing_address).toBeNull()
  await db.exec('set role authenticated')
  try { await expect(db.query('select billing_save_profile($1,$2::jsonb)', [ids.other, JSON.stringify({ ...payer, actorId: ids.owner })])).rejects.toThrow(/permission denied/) }
  finally { await db.exec('reset role') }
  const before = await service.account(ids.tenant)
  await expect(service.saveProfile(ids.tenant, 'invalid-actor', { ...payer, legalName: 'Should roll back' })).rejects.toThrow('BILLING_DB_PROFILE')
  expect((await service.account(ids.tenant)).legal_name).toBe(before.legal_name)
})

it('keeps a province printable when its entered name is not in the Odoo region catalog', async () => {
  const { service, odoo, start, doc } = await odooSetup()
  odoo.states = []
  const payment = await start()
  await service.reconcile(ids.tenant)
  expect(odoo.partners[0]).toMatchObject({ street2: payer.address.province, state_id: false })
  expect(await doc(payment.id)).toMatchObject({ state: 'proforma' })
})


it('reconciles a linked customer with no payments without querying an empty invoice filter', async () => {
  const { service, db, odoo } = await odooSetup()
  await service.account(ids.tenant)
  await db.query("update billing_accounts set stripe_customer_id='cst_empty', source='stripe' where tenant_id=$1", [ids.tenant])
  await expect(service.reconcile(ids.tenant)).resolves.toBeDefined()
  expect((await db.query('select * from billing_invoices')).rows).toHaveLength(0)
  expect(odoo.moves).toHaveLength(0)
})
