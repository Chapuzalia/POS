import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsePaymentAmount, withCustomPayments } from '../../src/lib/customPayments'
import { summarizeSales } from '../../src/features/cash-registers/services/cashSummary'
import { withConfirmedRestaurantPayments } from '../../src/features/restaurant/services/paymentPayload'
import type { SaleCreatedPayload } from '../../src/types'
import { venueRestaurantDb, ids, uuid } from '../helpers/venue-restaurant-db.mjs'
import { compileComponent } from '../helpers/component-harness.mjs'
import { createDurableSalesHarness } from '../helpers/durable-sales-harness.mjs'
import * as customPayments from '../../src/lib/customPayments'

const migration = readFileSync(new URL('../../supabase/migrations/20261029180735_custom_cash_card_payments.sql', import.meta.url), 'utf8')

afterEach(() => vi.unstubAllGlobals())

describe('custom payment amounts', () => {
  it('accepts comma or dot cents and rejects fractions of a cent, negatives and invalid input', () => {
    expect(parsePaymentAmount('3')).toBe(300)
    expect(parsePaymentAmount('3,01')).toBe(301)
    expect(parsePaymentAmount('4.99')).toBe(499)
    for (const input of ['', '-3', '1.001', 'abc', '1e3', 'Infinity', '9007199254740991']) expect(parsePaymentAmount(input)).toBeNull()
  })

  it('keeps one sale with two exact tenders and accounts each amount to its own method', () => {
    vi.stubGlobal('window', { crypto })
    const payload = { sale: { id: 'sale', tenantId: 'tenant', totalCents: 700, paymentMethod: 'card' }, payment: null } as SaleCreatedPayload
    const mixed = withCustomPayments(payload, 300)
    expect(mixed.sale.id).toBe('sale')
    expect(mixed.sale.paymentMethod).toBeNull()
    expect(mixed.payments?.map(payment => [payment.method, payment.amountCents])).toEqual([['cash', 300], ['card', 400]])
    expect(new Set(mixed.payments?.map(payment => payment.id)).size).toBe(2)
    const summary = summarizeSales(0, [{ id: 'sale', cashSessionId: 'session', totalCents: 700, paymentMethod: null, payments: mixed.payments, createdAt: '' }])
    expect(summary.cashCents).toBe(300)
    expect(summary.cardCents).toBe(400)
    expect(withConfirmedRestaurantPayments(payload, { payments: mixed.payments })).toMatchObject(mixed)
    for (const cash of [0, -1, 700, 701, 3.5, NaN]) expect(() => withCustomPayments(payload, cash)).toThrow()
  })
})

describe('custom payment database transactions', () => {
  async function fixture() {
    const fixture = await venueRestaurantDb()
    await fixture.db.exec(migration)
    return fixture
  }

  it('rejects invalid splits and unauthorized scopes without closing or creating a sale', async () => {
    const { db, query, open, addLines, pay } = await fixture()
    try {
      const orderId = await open()
      await addLines(orderId)
      for (const cash of [0, 1000, -1, 1.5]) await expect(pay(orderId, { customCashCents: cash })).rejects.toThrow()
      await expect(pay(orderId, { customCashCents: 300 }, uuid(999))).rejects.toThrow(/FORBIDDEN/)
      expect((await query('select count(*)::integer n from sales'))[0].n).toBe(0)
      expect((await query('select status from orders where id=$1', [orderId]))[0].status).toBe('open')
    } finally { await db.close() }
  })

  it('applies a custom payment only to selected items and leaves the rest payable', async () => {
    const { db, query, open, addLines, pay } = await fixture()
    try {
      const orderId = await open()
      await addLines(orderId)
      const first = await pay(orderId, { moves: [{ lineId: ids.line, quantity: 1 }], customCashCents: 200 }, ids.deviceB, uuid(80), 'selected_items')
      expect(first.payments.map(payment => payment.amountCents)).toEqual([200, 300])
      await pay(orderId, { expectedRevision: first.revision, moves: [{ lineId: ids.line, quantity: 1 }] }, ids.deviceA, uuid(81), 'selected_items')
      expect((await query('select sum(total_cents)::integer total from sales'))[0].total).toBe(1000)
      expect((await query('select count(*)::integer n from sale_payments'))[0].n).toBe(3)
    } finally { await db.close() }
  })

  it('keeps custom diner payments and Cashlogy identity through the final single ticket', async () => {
    const { db, query, open, addLines, pay } = await fixture()
    try {
      const orderId = await open()
      await addLines(orderId)
      const split = (await query('select configure_restaurant_equal_split_single($1,3,0,null) result', [orderId]))[0].result
      const payPart = (part: number, extra = {}) => pay(orderId, { splitId: split.id, singleTicket: true, expectedPaidParts: part, finalPart: part === 2, useDefaultDiscount: true, ...extra }, ids.deviceB, uuid(90 + part), 'equal_part')
      const hardware = { customCashCents: 123, cashlogyRequestId: 'machine-request', cashlogyTransactionId: 'machine-receipt', customCashReceivedCents: 200 }
      const first = await payPart(0, hardware)
      expect(first.completed).toBe(false)
      expect(await payPart(0, hardware)).toEqual(first)
      await expect(payPart(1, hardware)).rejects.toThrow(/Cashlogy|duplicate/)
      await payPart(1)
      const last = await payPart(2, { customCashCents: 33 })
      expect(last.totalCents).toBe(1000)
      expect(last.payments.reduce((sum: number, payment: { amountCents: number }) => sum + payment.amountCents, 0)).toBe(1000)
      expect(last.payments.filter(payment => payment.method === 'cash').map(payment => payment.amountCents)).toEqual([123, 33])
      expect((await query('select count(*)::integer n from tickets'))[0].n).toBe(1)
      expect((await query('select count(*)::integer n from sale_payments'))[0].n).toBe(5)
      expect((await query("select amount_cents,change_cents from sale_payments where cashlogy_transaction_id='machine-receipt'"))[0]).toEqual({ amount_cents: 123, change_cents: 77 })
    } finally { await db.close() }
  })

  it('synchronizes an offline mixed sale once and rejects malformed or cross-tenant tenders', async () => {
    const { db, query } = await fixture()
    try {
      await db.exec(`create function public.user_has_tenant_access(uuid) returns boolean language sql as $$select $1='${ids.tenant}'::uuid$$;
        create table public.offline_event_log(id uuid default gen_random_uuid(),tenant_id uuid,event_kind text,client_event_id uuid,payload jsonb,
          sale_cash_session_id text generated always as (payload -> 'ticket' ->> 'cashSessionId') stored,
          sale_ticket_id text generated always as (payload -> 'ticket' ->> 'id') stored,created_at timestamptz default now(),unique(tenant_id,client_event_id));
        alter table tickets add if not exists discount_snapshot jsonb,add if not exists discount_rule_kind text,
          add if not exists discount_scope text,add if not exists discount_automatic boolean;
        alter table ticket_lines add if not exists discount_amount_cents integer,add if not exists net_total_cents integer;`)
      const ticketId = uuid(500), saleId = uuid(501)
      const common = { tenantId: ids.tenant, cashSessionId: ids.sessionB, cashRegisterId: ids.registerB, venueId: ids.venue, deviceId: ids.deviceB, userId: ids.user, totalCents: 700, createdAt: '2026-10-29T12:00:00Z' }
      const payload = { ticket: { ...common, id: ticketId, subtotalCents: 700, discountAmountCents: 0, discount: null },
        sale: { ...common, id: saleId, ticketId, paymentMethod: null }, payment: null,
        lines: [{ id: uuid(502), tenantId: ids.tenant, ticketId, productName: 'Plato', variantName: '', quantity: 1, unitPriceCents: 700, lineTotalCents: 700, discountAmountCents: 0, netTotalCents: 700, modifiers: [] }],
        payments: [
          { id: uuid(503), tenantId: ids.tenant, saleId, method: 'cash', amountCents: 300, receivedCents: 500, changeCents: 200 },
          { id: uuid(504), tenantId: ids.tenant, saleId, method: 'card', amountCents: 400, receivedCents: null, changeCents: 0 },
        ] }
      const sync = (value = payload) => query('select sync_sale_created_v2($1,$2)', [uuid(505), value])
      for (const patch of [{ amountCents: 401 }, { tenantId: ids.otherTenant }, { method: 'cash' }, { id: uuid(503) }]) {
        await expect(sync({ ...payload, payments: [payload.payments[0], { ...payload.payments[1], ...patch }] })).rejects.toThrow()
      }
      await sync()
      await sync()
      expect((await query('select count(*)::integer n from sales'))[0].n).toBe(1)
      expect(await query('select method,amount_cents from sale_payments order by method')).toEqual([{ method: 'card', amount_cents: 400 }, { method: 'cash', amount_cents: 300 }])
    } finally { await db.close() }
  })

  it('stores both tenders before the fiscal record and replays its original result', async () => {
    const { db, query, open, addLines } = await fixture()
    try {
      const orderId = await open()
      await addLines(orderId)
      const subject = uuid(300), installation = uuid(301), recordId = uuid(302), invoiceId = uuid(303)
      await query("insert into fiscal_subjects values($1,$2,'B12345678')", [subject, ids.tenant])
      await query("insert into fiscal_sif_installations values($1,$2,$3,$4,$5,$6,null,'production','L1','C2','I1',2,1)", [installation, ids.tenant, subject, ids.venue, ids.registerB, ids.deviceB])
      const issuedAt = new Date().toISOString()
      const date = (await query("select to_char($1::timestamptz at time zone 'Europe/Madrid','DD-MM-YYYY') date", [issuedAt]))[0].date
      const series = `L1-C2-1-${date.slice(-4)}-S`, hash = 'A'.repeat(64)
      const record = { tenantId: ids.tenant, venueId: ids.venue, cashRegisterId: ids.registerB, deviceId: ids.deviceB,
        fiscalSubjectId: subject, installationId: installation, idempotencyKey: recordId, invoiceId, issuerNif: 'B12345678', environment: 'production',
        generatedAt: issuedAt, canonicalSchema: 'aeat-registro-v1', chainPosition: 1, hash, previous: null, lease: { fencingToken: 1 },
        canonicalRecord: { RegistroAlta: { TipoFactura: 'F2', Huella: hash, ImporteTotal: '10.00', FechaHoraHusoGenRegistro: issuedAt,
          IDFactura: { IDEmisorFactura: 'B12345678', NumSerieFactura: `${series}/1`, FechaExpedicionFactura: date }, Encadenamiento: { PrimerRegistro: 'S' } } } }
      const params = { orderId, cashSessionId: ids.sessionB, paymentOperationId: uuid(304), expectedRevision: 0, method: 'card', allowPending: true, customCashCents: 300 }
      const invoice = { invoiceId, series, number: 1, issuedAt, totalCents: 1000 }
      const issue = async () => (await query("select pay_restaurant_local_fiscal('close',$1,$2,$3) result", [params, record, invoice]))[0].result
      const first = await issue()
      expect(first.payments.map(payment => [payment.method, payment.amountCents])).toEqual([['cash', 300], ['card', 700]])
      expect(await issue()).toEqual(first)
      expect((await query('select count(*)::integer n from fiscal_local_records'))[0].n).toBe(1)
      expect((await query('select count(*)::integer n from sale_payments'))[0].n).toBe(2)
    } finally { await db.close() }
  })

  it('charges only the cash portion and recovers a lost reply without charging again', async () => {
    const { db, query, open, addLines, pay } = await fixture()
    vi.stubGlobal('window', { crypto })
    try {
      const orderId = await open()
      await addLines(orderId, 1)
      await query('update order_lines set unit_price_cents=700 where order_id=$1', [orderId])
      const durable = createDurableSalesHarness()
      const charges: number[] = []
      let loseReply = true
      const service = compileComponent(readFileSync(new URL('../../src/features/restaurant/services/payment.ts', import.meta.url), 'utf8'), {
        '../../../lib/customPayments': customPayments,
        './paymentPayload.ts': { withConfirmedRestaurantPayments },
        '../../../lib/durableSales.ts': { ...durable, markRestaurantCheckoutReserved: async operation => ({ ...operation, checkoutReserved: true }) },
        './checkout.ts': { prepareRestaurantCheckout: async () => {}, startRestaurantCheckout: async () => {}, releaseRestaurantCheckout: async () => true },
        '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => 'disabled' },
        '../../fiscal/local/posInvoice.ts': {}, '../../fiscal/local/restaurantInvoice.ts': {},
        '../../local-printing/cashlogy/useCashlogyStore.ts': {
          isCashlogyPaymentConfigured: () => true,
          settleCashlogyPaymentIfConfigured: async (amount: number, saleId: string, requestId: string) => {
            charges.push(amount)
            return { saleId, requestId, id: 'machine-receipt', requestedAmountCents: amount, receivedCents: 500, changeCents: 200 }
          },
          getCashlogyPaymentAmounts: transaction => transaction,
        },
        '../../tables/service.ts': { payRestaurantIdempotent: async (_context, operationId, _action, params) => {
          const result = await pay(orderId, params, ids.deviceB, operationId)
          if (loseReply) { loseReply = false; throw new Error('Reply lost') }
          return result
        } },
      }, { JSON })
      const input = { context: { tenantId: ids.tenant, venueId: ids.venue, deviceId: ids.deviceB, userId: ids.user }, session: { id: ids.sessionB }, action: 'close', target: orderId,
        draft: { ticket: { id: uuid(700), totalCents: 700 }, sale: { id: uuid(701), tenantId: ids.tenant, totalCents: 700, paymentMethod: 'card' }, payment: null, lines: [] },
        params: { orderId, expectedRevision: 0, method: 'card', allowPending: true, customCashCents: 300 } }
      await expect(service.payRestaurantSale(input)).rejects.toThrow('Reply lost')
      const recovered = await service.payRestaurantSale(input)
      expect(charges).toEqual([300])
      expect(recovered.payload.payments.map(payment => [payment.method, payment.amountCents])).toEqual([['cash', 300], ['card', 400]])
      expect(recovered.payload.payments[0].changeCents).toBe(200)
      expect((await query('select count(*)::integer n from sales'))[0].n).toBe(1)
    } finally { await db.close() }
  })
})
