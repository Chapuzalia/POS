// Mirrors each Mollie payment (billing_invoices row) into Odoo, Alteil's fiscal issuer:
// pending → proforma (sale.order), settled → posted and paid invoice, charged back → credit note.
// Odoo never blocks billing: errors are recorded per payment and retried on the next reconcile.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { netFromGross } from './mollie.ts'
import type { MolliePayment } from './mollie.ts'
import { ODOO_ERROR_CODES, OdooRequestError } from './odoo.ts'
import type { OdooErrorCode, OdooGateway } from './odoo.ts'

export type OdooState = 'proforma' | 'invoiced' | 'canceled' | 'refunded' | 'failed'
type Target = Exclude<OdooState, 'failed'>
type InvoiceRow = { stripe_invoice_id: string; status: string; amount_due_cents: number; paid_excluding_tax_cents: number; paid_at: string | Date | null; created_at: string | Date }
type DocumentRow = { payment_id: string; state: OdooState; sale_order_id: number | null; invoice_id: number | null; refund_id: number | null; invoice_number: string | null; attempts: number }
type Ids = Pick<DocumentRow, 'sale_order_id' | 'invoice_id' | 'refund_id' | 'invoice_number'>
type SyncAccount = { tenant_id: string; legal_name: string | null; tax_id: string | null; odoo_partner_id?: number | string | null }
type Move = { id: number; state: string; name: string; amount_total: number; payment_state: string; move_type: string }

export const ODOO_PRODUCT_CODE = 'TICKIT-SUB'
export const ODOO_PAYMENT_JOURNAL_CODE = 'MOLL'
const MAX_PER_RUN = 10
const MOVE_FIELDS = ['state', 'name', 'amount_total', 'payment_state', 'move_type']

export function targetOdooState(status: string): Target | null {
  if (status === 'open' || status === 'processing') return 'proforma'
  if (status === 'paid') return 'invoiced'
  if (status === 'uncollectible') return 'refunded'
  if (['void', 'failed', 'expired', 'canceled'].includes(status)) return 'canceled'
  return null
}

// Forward-only: a posted invoice is only ever corrected by a credit note; a payment Odoo never saw needs no cancellation.
function needsWork(doc: DocumentRow | undefined, target: Target | null) {
  if (!target || doc?.state === target) return false
  if (!doc) return target !== 'canceled'
  if ((doc.state === 'invoiced' || doc.state === 'refunded') && (target === 'proforma' || target === 'canceled')) return false
  return !(doc.state === 'canceled' && target === 'proforma')
}

// Fiscal dates are Spanish calendar days; timestamps arrive as ISO strings (PostgREST) or Dates.
const madridDate = (value: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(value))
const id = (value:number | string | null | undefined) => value === null || value === undefined ? null : Number(value)
const codeOf = (error: unknown): OdooErrorCode => error instanceof OdooRequestError || (error instanceof Error && (ODOO_ERROR_CODES as readonly string[]).includes(error.message)) ? (error as Error).message as OdooErrorCode : 'ODOO_REJECTED'
const fail = (code: OdooErrorCode): never => { throw new OdooRequestError(code) }

export function odooVat(taxId: string) {
  const vat = taxId.replace(/[\s.-]/g, '').toUpperCase()
  // Spanish NIF/NIE/CIF (9 chars) get the ES prefix Odoo expects; foreign VAT numbers keep their own prefix.
  return /^[0-9A-Z]\d{7}[0-9A-Z]$/.test(vat) || !/^[A-Z]{2}/.test(vat) ? `ES${vat}` : vat
}

class Sync {
  private readonly odoo: OdooGateway
  private readonly db: SupabaseClient
  private readonly account: SyncAccount
  private readonly mode: string
  private partnerId: number | null
  private setup: { product: number; journal: number } | null = null
  constructor(odoo: OdooGateway, db: SupabaseClient, account: SyncAccount, mode: string) {
    this.odoo = odoo; this.db = db; this.account = account; this.mode = mode; this.partnerId = id(account.odoo_partner_id)
  }
  private async first<T>(model: string, domain: unknown[], fields: string[]) {
    const [row] = await this.odoo.call<T[]>(model, 'search_read', { domain, fields, limit: 1 })
    return row ?? null
  }
  private async create(model: string, vals: object, context?: object) {
    const [created] = await this.odoo.call<number[]>(model, 'create', { vals_list: [vals], ...(context ? { context } : {}) })
    return created
  }
  private async references() {
    if (this.setup) return this.setup
    const product = await this.first<{ id: number }>('product.product', [['default_code', '=', ODOO_PRODUCT_CODE]], ['id'])
    const journal = await this.first<{ id: number }>('account.journal', [['code', '=', ODOO_PAYMENT_JOURNAL_CODE]], ['id'])
    if (!product || !journal) fail('ODOO_SETUP_MISSING')
    this.setup = { product: product!.id, journal: journal!.id }
    return this.setup
  }
  private async partner() {
    if (this.partnerId) return this.partnerId
    const { legal_name: name, tax_id: taxId } = this.account
    if (!name?.trim() || !taxId?.trim()) return fail('ODOO_PARTNER_INVALID')
    const vat = odooVat(taxId)
    const found = await this.first<{ id: number }>('res.partner', [['vat', '=', vat], ['is_company', '=', true]], ['id'])
    let partner = found?.id
    if (!partner) {
      const country = await this.first<{ id: number }>('res.country', [['code', '=', vat.slice(0, 2)]], ['id'])
      partner = await this.create('res.partner', { name: name.trim(), vat, is_company: true, ...(country ? { country_id: country.id } : {}) })
    }
    const saved = await this.db.from('billing_accounts').update({ odoo_partner_id: partner }).eq('tenant_id', this.account.tenant_id)
    if (saved.error) throw new Error('BILLING_DB_ODOO')
    this.partnerId = partner
    return partner
  }
  private async order(row: InvoiceRow, payment: MolliePayment | undefined) {
    const fields = ['state', 'invoice_ids']
    const existing = await this.first<{ id: number; state: string; invoice_ids: number[] }>('sale.order', [['client_order_ref', '=', row.stripe_invoice_id]], fields)
    if (existing) return existing
    const [partner, { product }] = [await this.partner(), await this.references()]
    const netCents = row.paid_excluding_tax_cents || netFromGross(row.amount_due_cents)
    const created = await this.create('sale.order', {
      partner_id: partner, client_order_ref: row.stripe_invoice_id, origin: `Tickit ${this.mode}`,
      order_line: [[0, 0, { product_id: product, name: payment?.description || 'Tickit POS', product_uom_qty: 1, price_unit: netCents / 100 }]],
    })
    return { id: created, state: 'draft', invoice_ids: [] as number[] }
  }
  private async invoice(order: { id: number; state: string; invoice_ids: number[] }) {
    const find = async (ids: number[]) => ids.length ? this.first<Move>('account.move', [['id', 'in', ids], ['move_type', '=', 'out_invoice']], MOVE_FIELDS) : null
    const existing = await find(order.invoice_ids)
    if (existing) return existing
    if (order.state === 'draft' || order.state === 'sent') await this.odoo.call('sale.order', 'action_confirm', { ids: [order.id] })
    const wizard = await this.create('sale.advance.payment.inv', { advance_payment_method: 'delivered', sale_order_ids: [[6, 0, [order.id]]] })
    await this.odoo.call('sale.advance.payment.inv', 'create_invoices', { ids: [wizard] })
    const [reread] = await this.odoo.call<{ invoice_ids: number[] }[]>('sale.order', 'read', { ids: [order.id], fields: ['invoice_ids'] })
    return await find(reread?.invoice_ids ?? []) ?? fail('ODOO_REJECTED')
  }
  private async move(moveId: number) {
    const [move] = await this.odoo.call<Move[]>('account.move', 'read', { ids: [moveId], fields: MOVE_FIELDS })
    return move ?? fail('ODOO_REJECTED')
  }
  private async settle(row: InvoiceRow, invoice: Move) {
    if (invoice.state === 'draft') {
      // The fiscal invoice must match what Mollie charged to the cent; otherwise nothing is numbered.
      if (Math.round(invoice.amount_total * 100) !== row.amount_due_cents) fail('ODOO_TOTAL_MISMATCH')
      await this.odoo.call('account.move', 'action_post', { ids: [invoice.id] })
      invoice = await this.move(invoice.id)
    }
    if (invoice.state !== 'posted') fail('ODOO_REJECTED')
    if (!['paid', 'in_payment'].includes(invoice.payment_state)) {
      const context = { active_model: 'account.move', active_ids: [invoice.id] }
      const wizard = await this.create('account.payment.register', { journal_id: (await this.references()).journal, payment_date: madridDate(row.paid_at ?? row.created_at), communication: row.stripe_invoice_id }, context)
      await this.odoo.call('account.payment.register', 'action_create_payments', { ids: [wizard], context })
    }
    return invoice
  }
  private async refund(row: InvoiceRow, invoice: Move) {
    let refund = await this.first<Move>('account.move', [['reversed_entry_id', '=', invoice.id]], MOVE_FIELDS)
    if (!refund) {
      const context = { active_model: 'account.move', active_ids: [invoice.id] }
      const wizard = await this.create('account.move.reversal', { reason: `Devolución ${row.stripe_invoice_id}` }, context)
      await this.odoo.call('account.move.reversal', 'refund_moves', { ids: [wizard], context })
      refund = await this.first<Move>('account.move', [['reversed_entry_id', '=', invoice.id]], MOVE_FIELDS) ?? fail('ODOO_REJECTED')
    }
    if (refund.state === 'draft') await this.odoo.call('account.move', 'action_post', { ids: [refund.id] })
    return refund
  }
  async advance(row: InvoiceRow, target: Target, payment: MolliePayment | undefined): Promise<Ids> {
    if (target === 'canceled') {
      // Never create a proforma only to cancel it.
      const existing = await this.first<{ id: number; state: string }>('sale.order', [['client_order_ref', '=', row.stripe_invoice_id]], ['state'])
      if (existing && existing.state !== 'cancel') await this.odoo.call('sale.order', 'action_cancel', { ids: [existing.id] })
      return { sale_order_id: existing?.id ?? null, invoice_id: null, refund_id: null, invoice_number: null }
    }
    const order = await this.order(row, payment)
    const ids: Ids = { sale_order_id: order.id, invoice_id: null, refund_id: null, invoice_number: null }
    if (target === 'proforma') return ids
    const invoice = await this.settle(row, await this.invoice(order))
    Object.assign(ids, { invoice_id: invoice.id, invoice_number: invoice.name })
    if (target === 'refunded') ids.refund_id = (await this.refund(row, invoice)).id
    return ids
  }
}

export async function syncOdoo(input: { odoo: OdooGateway; db: SupabaseClient; account: SyncAccount; payments: MolliePayment[]; mode: string; deadline?: number }) {
  const { odoo, db, account, payments, mode } = input
  // The reconcile claim lasts 2 minutes; stop starting new payments well before it expires.
  const deadline = input.deadline ?? Date.now() + 60_000
  const tenantId = account.tenant_id
  const [invoices, documents] = await Promise.all([
    db.from('billing_invoices').select('stripe_invoice_id,status,amount_due_cents,paid_excluding_tax_cents,paid_at,created_at').eq('tenant_id', tenantId).order('created_at', { ascending: true }).limit(1000),
    db.from('billing_odoo_documents').select('payment_id,state,sale_order_id,invoice_id,refund_id,invoice_number,attempts').eq('tenant_id', tenantId).limit(1000),
  ])
  if (invoices.error || documents.error) return { processed: 0, failed: 1 }
  const docs = new Map((documents.data as DocumentRow[]).map(doc => [doc.payment_id, doc]))
  const sync = new Sync(odoo, db, account, mode)
  let processed = 0, failed = 0
  for (const row of invoices.data as InvoiceRow[]) {
    const doc = docs.get(row.stripe_invoice_id)
    const target = targetOdooState(row.status)
    if (!needsWork(doc, target) || !target) continue
    if (processed >= MAX_PER_RUN || Date.now() > deadline) break
    processed++
    const previous: Ids = { sale_order_id: id(doc?.sale_order_id), invoice_id: id(doc?.invoice_id), refund_id: id(doc?.refund_id), invoice_number: doc?.invoice_number ?? null }
    try {
      const ids = await sync.advance(row, target, payments.find(payment => payment.id === row.stripe_invoice_id))
      await save(db, tenantId, row.stripe_invoice_id, { ...ids, state: target, last_error: null, attempts: doc?.attempts ?? 0 }, {
        fiscal_export_status: ids.invoice_id ? 'exported' : 'pending_review', number: ids.invoice_number,
        fiscal_external_reference: ids.invoice_id ? `account.move:${ids.invoice_id}` : `sale.order:${ids.sale_order_id}`,
      })
    } catch (error) {
      failed++
      try { await save(db, tenantId, row.stripe_invoice_id, { ...previous, state: 'failed', last_error: codeOf(error), attempts: (doc?.attempts ?? 0) + 1 }, { fiscal_export_status: 'failed' }) }
      catch { /* Retried on the next reconcile; billing must not fail because of Odoo bookkeeping. */ }
    }
  }
  return { processed, failed }
}

async function save(db: SupabaseClient, tenantId: string, paymentId: string, doc: Ids & { state: OdooState; last_error: string | null; attempts: number }, invoice: Record<string, string | null>) {
  const saved = await db.from('billing_odoo_documents').upsert({ payment_id: paymentId, tenant_id: tenantId, ...doc, updated_at: new Date().toISOString() }, { onConflict: 'payment_id' })
  if (saved.error) throw new Error('BILLING_DB_ODOO')
  const mirrored = await db.from('billing_invoices').update(invoice).eq('stripe_invoice_id', paymentId).eq('tenant_id', tenantId)
  if (mirrored.error) throw new Error('BILLING_DB_ODOO')
}
