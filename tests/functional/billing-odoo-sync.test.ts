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
  await db.query('update billing_accounts set legal_name=null where tenant_id=$1', [ids.tenant])
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
