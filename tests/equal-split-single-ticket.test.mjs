import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { IDBFactory } from 'fake-indexeddb'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { withConfirmedRestaurantPayments } from '../src/features/restaurant/services/paymentPayload.ts'
import { summarizeSales } from '../src/features/cash-registers/services/cashSummary.ts'
import * as durable from '../src/lib/durableSales.ts'
import { compileComponent } from './helpers/component-harness.mjs'
import { createRestaurantControllerHarness } from './helpers/restaurant-controller-harness.mjs'

const migration = readFileSync(new URL('../supabase/migrations/20261014115222_equal_split_single_ticket.sql', import.meta.url), 'utf8')
const base = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const [tenant, venue, user, device, session, register, group, order, split] = Array.from({ length: 9 }, (_, n) => uuid(n + 1))

async function fixture() {
  const db = new PGlite()
  await db.exec(`create schema auth; create role authenticated; create role anon; create role service_role;
    create table auth.users(id uuid primary key); create table public.tenants(id uuid primary key); create table public.venues(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function public.user_has_venue_access(uuid,uuid) returns boolean language sql as $$select $1='${tenant}'::uuid and $2='${venue}'::uuid and auth.uid()='${user}'::uuid$$;
    create function public.user_has_device_access(uuid,uuid,uuid) returns boolean language sql as $$select public.user_has_venue_access($1,$2) and $3='${device}'::uuid$$;
    create function public.record_restaurant_order_event(uuid,text,jsonb) returns void language plpgsql as $$begin return; end;$$;
    create function public.resolve_ticket_discount(uuid,uuid,integer,jsonb) returns jsonb language sql as $$select case when $4 is null or $4='null'::jsonb then jsonb_build_object('amountCents',0,'totalCents',$3) else $4 || jsonb_build_object('amountCents',least($3,($4->>'value')::integer),'totalCents',$3-least($3,($4->>'value')::integer)) end$$;
  `)
  for (const table of ['devices','cash_sessions','order_groups','orders','order_lines','order_tables','restaurant_order_equal_splits','tickets','ticket_lines','sales','sale_payments','device_user_assignments']) {
    await db.exec(base.match(new RegExp(`CREATE TABLE public\\.${table} \\([\\s\\S]*?\\r?\\n\\);`))[0])
    if (table !== 'order_tables') await db.exec(`alter table public.${table} add primary key(id)`)
  }
  await db.exec(`alter table public.restaurant_order_equal_splits add unique(order_id);
    alter table public.ticket_lines add source_order_line_id uuid;
    alter table public.sale_payments add cashlogy_request_id text, add cashlogy_transaction_id text;
    create table public.restaurant_payment_operations(operation_id uuid primary key,tenant_id uuid,venue_id uuid,device_id uuid,user_id uuid,action text,params jsonb,result jsonb);
    alter table public.venues add tenant_id uuid, add timezone text default 'Europe/Madrid';
    create table public.fiscal_sif_installations(id uuid,tenant_id uuid,fiscal_subject_id uuid,venue_id uuid,cash_register_id uuid,device_id uuid,retired_at timestamptz,mode text,venue_code text,register_code text,installation_code text,series_version integer,installation_sequence integer);
    create table public.fiscal_subjects(id uuid,tenant_id uuid,nif text);
    create table public.fiscal_local_records(id uuid,tenant_id uuid,fiscal_subject_id uuid,installation_id uuid,venue_id uuid,cash_register_id uuid,invoice_id uuid,ticket_id uuid,sale_id uuid,record_kind text,chain_position bigint,previous_hash text,hash text,canonical_schema text,canonical_record jsonb,record_envelope jsonb,invoice_snapshot jsonb,generated_at timestamptz,idempotency_key uuid,rpc_result jsonb);
    create table public.fiscal_local_series(id uuid default gen_random_uuid(),tenant_id uuid,fiscal_subject_id uuid,installation_id uuid,venue_id uuid,cash_register_id uuid,device_id uuid,document_kind text,exercise integer,series text,last_number bigint default 0,unique(tenant_id,fiscal_subject_id,series));
    create table public.customers(id uuid,tenant_id uuid);
    create table public.fiscal_integration_settings(tenant_id uuid,enabled boolean);
    create function public.fiscal_series_exercise(text) returns integer language sql as $$select split_part($1,'-',4)::integer$$;
    create function public.fiscal_installation_series_prefix(public.fiscal_sif_installations) returns text language sql as $$select $1.venue_code || '-' || $1.register_code || '-' || $1.installation_sequence::text$$;
  `)
  for (const name of ['restaurant_equal_split_to_json', 'configure_restaurant_order_equal_split']) {
    await db.exec(base.match(new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*?\\r?\\n\\$\\$;`, 'i'))[0])
  }
  await db.exec(`alter table public.venues add name text default 'Local';`)
  await db.exec(base.match(/CREATE TABLE public\.ticket_line_components \([\s\S]*?\r?\n\);/)[0])
  await db.exec(migration)
  await db.exec(`insert into public.tenants values('${tenant}'); insert into public.venues(id,tenant_id) values('${venue}','${tenant}'); insert into auth.users values('${user}');
    insert into public.devices(id,tenant_id,venue_id,name) values('${device}','${tenant}','${venue}','Checkout');
    insert into public.device_user_assignments(tenant_id,venue_id,device_id,user_id) values('${tenant}','${venue}','${device}','${user}');
    insert into public.cash_sessions(id,tenant_id,venue_id,opened_by,status,cash_register_id) values('${session}','${tenant}','${venue}','${user}','open','${register}');
    insert into public.order_groups(id,tenant_id,venue_id,cash_session_id) values('${group}','${tenant}','${venue}','${session}');
    insert into public.orders(id,tenant_id,venue_id,cash_session_id,opened_by_user_id,opened_by_device_id,cash_register_id,order_group_id) values('${order}','${tenant}','${venue}','${session}','${user}','${device}','${register}','${group}');
    insert into public.order_lines(id,tenant_id,venue_id,order_id,product_name,variant_name,unit_price_cents,quantity,served_quantity) values('${uuid(10)}','${tenant}','${venue}','${order}','Cena','',501,2,2),('${uuid(11)}','${tenant}','${venue}','${order}','Agua','',0,1,1);
    set test.uid='${user}';
  `)
  const configured = (await db.query('select public.configure_restaurant_equal_split_single($1,3,0,null) as result', [order])).rows[0].result
  const pay = async (part, method = 'card', received = null, discount = null, operation = uuid(20 + part), scopeTenant = tenant, hardware = {}) => {
    const params = { splitId: configured.id, singleTicket: true, expectedPaidParts: part, finalPart: part === 2, method, receivedCents: received,
      allowPending: false, discount, useDefaultDiscount: discount === null, ...hardware }
    return (await db.query("select public.pay_restaurant_equal_split_single_idempotent($1,$2,$3,$4,'equal_part',$5) as result", [operation, scopeTenant, venue, device, params])).rows[0].result
  }
  return { db, pay, configured }
}

test('migration is additive and preserves the legacy split APIs', () => {
  assert.deepEqual(analyzeMigration(migration), [])
  assert.doesNotMatch(migration, /create or replace function public\.(?:pay_restaurant_order_equal_part|pay_restaurant_local_fiscal|pay_restaurant_idempotent)\(/i)
})

test('the controller pays three consecutive shares with an inherited per-unit discount without fractional product quantities', async () => {
  const discount = { discountId: null, name: 'Descuento por unidad', type: 'fixed', calculationType: 'fixed', value: 30, fixedApplication: 'unit', roundingIncrementCents: null, color: null }
  let split = { id: 'split', orderId: 'order', orderGroupId: 'group', singleTicket: true, totalCents: 1200, partCount: 3, paidParts: 0, paidCents: 0, remainingParts: 3,
    remainingCents: 1200, nextPartCents: 400, nextDefaultDiscount: discount, nextDefaultDiscountAmountCents: 30, nextDefaultTotalCents: 370, tenders: [], status: 'open', revision: 1 }
  const line = (id, price) => ({ id, tenantId: 'tenant', productId: id, variantId: id, productName: id, variantName: '', quantity: 1, servedQuantity: 1, unitPriceCents: price,
    modifiers: [], components: [], catalogSnapshot: {}, mixer: null, note: null, createdAt: id })
  const harness = createRestaurantControllerHarness({ realPayloads: true,
    currentOrder: { order: { id: 'order', revision: 1, status: 'open' }, lines: [line('a',400),line('b',800)], tables: [{ areaId: 'area', id: 'table', isVirtual: false }] },
    tableService: {
      configureRestaurantEqualSplit: async () => split,
      payRestaurantEqualPart: async () => {
        const part = split.paidParts + 1
        split = { ...split, paidParts: part, remainingParts: 3-part, paidCents: part*400, remainingCents: (3-part)*400,
          tenders: [...split.tenders,{ id: `payment-${part}`, method: 'card', amountCents: 370, partNumber: part, discountAmountCents: 30 }] }
        return { requiresConfirmation: false, split, completed: part === 3, singleTicket: true, paidAmountCents: 370,
          ticketId: part === 3 ? 'ticket' : null, saleId: part === 3 ? 'sale' : null, paymentId: `payment-${part}`, nextOrderId: null,
          payments: part === 3 ? split.tenders.map(tender => ({ ...tender, tenantId: 'tenant', saleId: 'sale', receivedCents: null, changeCents: 0 })) : [] }
      },
    } })
  harness.mapRefresh.resolve({ areas: [{ id: 'area' }], tables: [] })
  await harness.render().configureEqualSplit(3)
  await harness.render().payEqualSplitPart('card',null,false,null,true)
  assert.equal(split.paidParts, 1)
  await harness.render().payEqualSplitPart('card',null,false,null,true)
  assert.equal(split.paidParts, 2)
  assert.equal(harness.calls.prints, 0)
  await harness.render().payEqualSplitPart('card',null,false,null,true)
  assert.equal(split.paidParts, 3)
  assert.equal(harness.calls.prints, 1)
  assert.equal(harness.calls.printed[0].sale.totalCents, 1110)
  assert.equal(harness.calls.printed[0].ticket.discountAmountCents, 90)
  assert.deepEqual(harness.calls.printed[0].lines.map(line => [line.quantity,line.unitPriceCents]), [[1,400],[1,800]])
  assert.deepEqual(harness.calls.printed[0].payments.map(payment => payment.amountCents), [370,370,370])
})

test('three equal tenders create one full ticket only at completion, with exact cents and replay', async t => {
  const { db, pay } = await fixture()
  t.after(() => db.close())
  const first = await pay(0, 'cash', 400)
  assert.equal(first.completed, false)
  assert.equal(first.ticketId, null)
  assert.equal(first.paidAmountCents, 334)
  assert.deepEqual(await pay(0, 'cash', 400), first)
  assert.equal((await db.query('select count(*)::int as n from public.tickets')).rows[0].n, 0)
  assert.equal((await db.query('select count(*)::int as n from public.sales')).rows[0].n, 0)
  await assert.rejects(pay(0, 'cash', 400, null, uuid(99)), /reparto ha cambiado/)
  await assert.rejects(pay(1, 'card', null, null, uuid(100), uuid(200)), /FORBIDDEN/)
  await assert.rejects(db.exec(`update public.cash_sessions set status='closed' where id='${session}'`), /repartos parcialmente cobrados/)
  await assert.rejects(db.exec(`update public.orders set cash_session_id='${uuid(88)}' where id='${order}'`), /Completa el reparto/)
  await pay(1)
  const last = await pay(2)
  assert.equal(last.completed, true)
  assert.equal(last.totalCents, 1002)
  assert.deepEqual(last.payments.map(p => [p.method,p.amountCents]), [['cash',334],['card',334],['card',334]])
  assert.deepEqual(await pay(2), last)
  assert.equal((await db.query('select count(*)::int as n from public.tickets')).rows[0].n, 1)
  assert.equal((await db.query('select count(*)::int as n from public.sales')).rows[0].n, 1)
  assert.equal((await db.query('select payment_method from public.sales')).rows[0].payment_method, null)
  assert.deepEqual((await db.query('select quantity,unit_price_cents,line_total_cents from public.ticket_lines order by unit_price_cents')).rows,
    [{ quantity: 1, unit_price_cents: 0, line_total_cents: 0 },{ quantity: 2, unit_price_cents: 501, line_total_cents: 1002 }])
  assert.equal((await db.query('select status from public.orders')).rows[0].status, 'paid')
  const stats = (await db.query("select public.crm_stats_live($1,$2,now()-interval '1 day',now()+interval '1 day') as result",[tenant,venue])).rows[0].result
  assert.deepEqual(stats.dayActivity, { totalCents: 1002, cashCents: 334, cardCents: 668, ticketCount: 1 })
  assert.equal(stats.openCashSessions[0].ticketCount, 1)
  assert.equal(stats.openCashSessions[0].salesCents, 1002)
  assert.equal(stats.openCashSessions[0].cashCents, 334)
  assert.equal(stats.openCashSessions[0].cardCents, 668)
  const period = (await db.query("select public.crm_stats_period($1,$2,'day',current_date,current_date,current_date,now()-interval '1 day',now()+interval '1 day','Europe/Madrid',null) as result",[tenant,venue])).rows[0].result
  assert.equal(period.monthTicketCount, 1)
  assert.deepEqual(period.byPayment, [{ method: 'card', totalCents: 668, count: 1 },{ method: 'cash', totalCents: 334, count: 1 }])
  await db.exec(`update public.cash_sessions set status='closed' where id='${session}'`)
})

test('per-person discounts and cash change remain separate while the sale total is aggregated', async t => {
  const { db, pay } = await fixture()
  t.after(() => db.close())
  await pay(0, 'cash', 400, { type: 'manual', calculationType: 'fixed', value: 34, name: 'Descuento' })
  await pay(1)
  const result = await pay(2)
  assert.equal(result.totalCents, 968)
  assert.equal(result.payments[0].changeCents, 100)
  assert.deepEqual((await db.query('select subtotal_cents,discount_amount_cents,total_cents from public.tickets')).rows[0],
    { subtotal_cents: 1002, discount_amount_cents: 34, total_cents: 968 })
  const payload = withConfirmedRestaurantPayments({ sale: { id: result.saleId, tenantId: tenant, totalCents: 968 }, payment: null }, result)
  assert.equal(payload.payment, null)
  assert.equal(payload.payments.length, 3)
  const totals = summarizeSales(1000, [{ totalCents: 968, paymentMethod: null, payments: payload.payments }])
  assert.equal(totals.cashCents, 1300)
  assert.equal(totals.cardCents, 668)
  assert.equal(totals.totalSalesCents, 968)
  assert.throws(() => withConfirmedRestaurantPayments(payload, { ...result, payments: result.payments.slice(1) }), /total de la venta/)
  assert.throws(() => withConfirmedRestaurantPayments(payload, { ...result, payments: [{ ...result.payments[0], tenantId: uuid(90) }] }), /no coincide/)
})

test('rounding preserves every cent and rejected cash attempts do not advance the split', async t => {
  const { db, pay } = await fixture()
  t.after(() => db.close())
  await db.exec(`update public.order_lines set unit_price_cents=500 where id='${uuid(10)}'`)
  await db.query('select public.configure_restaurant_equal_split_single($1,3,0,null)', [order])
  await assert.rejects(pay(0,'cash',333), /recibido insuficiente/)
  await assert.rejects(pay(0,null), /no valido/)
  assert.equal((await db.query('select paid_parts from public.restaurant_order_equal_splits')).rows[0].paid_parts, 0)
  await pay(0)
  await pay(1)
  const final = await pay(2)
  assert.equal(final.totalCents, 1000)
  assert.deepEqual(final.payments.map(payment => payment.amountCents), [334,333,333])
})

test('Cashlogy receipts are reserved by one share and transfer unchanged to its final sale payment', async t => {
  const { db, pay } = await fixture()
  t.after(() => db.close())
  const hardware = { cashlogyRequestId: 'physical-request', cashlogyTransactionId: 'physical-transaction' }
  await pay(0,'cash',400,null,uuid(20),tenant,hardware)
  await assert.rejects(pay(1,'cash',400,null,uuid(21),tenant,hardware), /Cashlogy ya pertenece/)
  await assert.rejects(db.query('insert into public.sale_payments(id,tenant_id,sale_id,method,amount_cents,received_cents,change_cents,cashlogy_request_id,cashlogy_transaction_id) values($1,$2,$3,\'cash\',334,400,66,$4,$5)',
    [uuid(101),tenant,uuid(102),hardware.cashlogyRequestId,hardware.cashlogyTransactionId]), /Cashlogy ya pertenece/)
  const simultaneous = await Promise.allSettled([pay(1,'card',null,null,uuid(22)),pay(1,'card',null,null,uuid(23))])
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(simultaneous.filter(result => result.status === 'rejected').length, 1)
  await pay(2,'card',null,null,uuid(24))
  assert.deepEqual((await db.query('select cashlogy_request_id,cashlogy_transaction_id from public.sale_payments where method=\'cash\'')).rows[0],
    { cashlogy_request_id: hardware.cashlogyRequestId, cashlogy_transaction_id: hardware.cashlogyTransactionId })
})

test('a fully discounted share keeps the original numbers of later payers', async t => {
  const { db, pay } = await fixture()
  t.after(() => db.close())
  const free = { type: 'manual', calculationType: 'fixed', value: 334, name: 'Invitación' }
  await pay(0,null,null,free)
  await pay(1)
  const result = await pay(2)
  assert.deepEqual(result.payments.map(payment => payment.partNumber), [2,3])
  assert.equal(result.totalCents, 668)
  assert.deepEqual((await db.query('select equal_split_part_number from public.sale_payments order by equal_split_part_number')).rows.map(row => row.equal_split_part_number), [2,3])
})

test('a fully discounted order completes as one zero-total sale without invented payments', async t => {
  const { db, pay } = await fixture()
  t.after(() => db.close())
  const free = { type: 'manual', calculationType: 'fixed', value: 334, name: 'Invitación' }
  await pay(0,null,null,free)
  await pay(1,null,null,free)
  const result = await pay(2,null,null,free)
  assert.equal(result.totalCents, 0)
  assert.deepEqual(result.payments, [])
  assert.equal((await db.query('select count(*)::int as n from public.sales')).rows[0].n, 1)
  assert.equal((await db.query('select count(*)::int as n from public.sale_payments')).rows[0].n, 0)
  assert.equal(withConfirmedRestaurantPayments({ sale: { id: result.saleId, tenantId: tenant, totalCents: 0 }, payment: null },result).payment, null)
})

test('the PostgreSQL fiscal transaction issues one PWA installation invoice, links all payments and replays the same record', async t => {
  const { db, pay, configured } = await fixture()
  t.after(() => db.close())
  const subject = uuid(300), installation = uuid(301), recordId = uuid(302), invoiceId = uuid(303)
  await db.exec(`insert into public.fiscal_subjects values('${subject}','${tenant}','B12345678');
    insert into public.fiscal_sif_installations values('${installation}','${tenant}','${subject}','${venue}','${register}','${device}',null,'production','L1','C1','I1',2,1);`)
  await pay(0)
  await pay(1)
  assert.equal((await db.query('select count(*)::int as n from public.fiscal_local_records')).rows[0].n, 0)
  const issuedAt = new Date().toISOString()
  const date = (await db.query("select to_char($1::timestamptz at time zone 'Europe/Madrid','DD-MM-YYYY') as date", [issuedAt])).rows[0].date
  const exercise = Number(date.slice(-4))
  const series = `L1-C1-1-${exercise}-S`
  const hash = 'A'.repeat(64)
  const record = { tenantId: tenant, venueId: venue, cashRegisterId: register, deviceId: device, fiscalSubjectId: subject, installationId: installation,
    idempotencyKey: recordId, invoiceId, issuerNif: 'B12345678', environment: 'production', generatedAt: issuedAt, canonicalSchema: 'aeat-registro-v1', chainPosition: 1, hash,
    previous: null, lease: { fencingToken: 1 }, canonicalRecord: { RegistroAlta: { TipoFactura: 'F2', Huella: hash, ImporteTotal: '10.02', FechaHoraHusoGenRegistro: issuedAt,
      IDFactura: { IDEmisorFactura: 'B12345678', NumSerieFactura: `${series}/1`, FechaExpedicionFactura: date }, Encadenamiento: { PrimerRegistro: 'S' } } } }
  const invoice = { invoiceId, series, number: 1, issuedAt, totalCents: 1002 }
  const params = { splitId: configured.id, singleTicket: true, expectedPaidParts: 2, finalPart: true, method: 'card', receivedCents: null, allowPending: false, discount: null, useDefaultDiscount: true }
  const issue = () => db.query("select public.pay_restaurant_equal_split_single_fiscal('equal_part',$1,$2,$3) as result", [params,record,invoice])
  const first = (await issue()).rows[0].result
  assert.equal(first.completed, true)
  assert.equal(first.payments.length, 3)
  assert.deepEqual((await issue()).rows[0].result, first)
  assert.equal((await db.query('select count(*)::int as n from public.fiscal_local_records')).rows[0].n, 1)
  assert.equal((await db.query('select count(*)::int as n from public.sales')).rows[0].n, 1)
  assert.equal((await db.query('select last_number from public.fiscal_local_series')).rows[0].last_number, 1)
  assert.equal((await db.query('select sale_id from public.fiscal_local_records')).rows[0].sale_id, first.saleId)
})

test('intermediate tender commits its journal without adding a durable sale or offline sale event', async () => {
  globalThis.indexedDB = new IDBFactory()
  globalThis.window = { location: { pathname: '/pos' } }
  const context = { tenantId: tenant, venueId: venue, deviceId: device, userId: user }
  const scope = durable.paymentScope(context, session)
  const payload = { ticket: { id: 'draft' }, sale: { id: 'pending-sale', tenantId: tenant, totalCents: 334 }, lines: [] }
  const operation = await durable.preparePaymentOperation(`${scope}|restaurant:equal_part:${split}`, 'first', payload, { singleTicket: true })
  await durable.commitPaymentOperation(operation, payload, false, { singleTicket: true, completed: false })
  assert.equal((await durable.loadPaymentOperation(operation.key)).state, 'committed')
  assert.equal((await durable.loadDurableSessionTickets(context, session)).length, 0)
  assert.equal((await durable.loadDurableEvents()).length, 0)
})

test('three payments traverse real IndexedDB, RPC mapping and PostgreSQL, including a lost second response', async t => {
  delete globalThis.window
  const { db, configured } = await fixture()
  t.after(() => db.close())
  globalThis.indexedDB = new IDBFactory()
  globalThis.window = { location: { pathname: '/pos' } }
  Object.defineProperty(globalThis,'navigator',{ configurable: true, value: { locks: { request: (_key,_options,work) => work() } } })
  const context = { tenantId: tenant, venueId: venue, deviceId: device, userId: user }
  const source = readFileSync(new URL('../src/features/tables/service.ts',import.meta.url),'utf8')
  const selected = ['function requireSupabase','function mapEqualSplit','export async function payRestaurantIdempotent']
    .map(name => source.slice(source.indexOf(name)).split('\n}')[0]+'\n}').join('\n')
  let loseSecondReply = true
  const rpcIds = []
  const tables = compileComponent(selected,{}, { supabase: { rpc: async (name,params) => {
    assert.equal(name,'pay_restaurant_equal_split_single_idempotent')
    rpcIds.push(params.p_operation_id)
    const answer = await db.query('select public.pay_restaurant_equal_split_single_idempotent($1,$2,$3,$4,$5,$6) as result',
      [params.p_operation_id,params.p_tenant_id,params.p_venue_id,params.p_device_id,params.p_action,params.p_params])
    if (params.p_params.expectedPaidParts === 1 && loseSecondReply) { loseSecondReply = false; throw new Error('Response lost after second payment') }
    return { data: answer.rows[0].result, error: null }
  } } })
  const charges = []
  const service = compileComponent(readFileSync(new URL('../src/features/restaurant/services/payment.ts',import.meta.url),'utf8'),{
    './checkout.ts': { prepareRestaurantCheckout: async () => {}, releaseRestaurantCheckout: async () => true, startRestaurantCheckout: async () => {} },
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
    '../../../lib/durableSales.ts': durable,
    '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => 'disabled' },
    '../../fiscal/local/posInvoice.ts': {}, '../../fiscal/local/restaurantInvoice.ts': {},
    '../../local-printing/cashlogy/useCashlogyStore.ts': {
      isCashlogyPaymentConfigured: () => true,
      settleCashlogyPaymentIfConfigured: async (amount,saleId,requestId) => { charges.push(amount); return { requestedAmountCents: amount,saleId,requestId,id:`physical-${charges.length}`,receivedCents:400,changeCents:400-amount } },
      getCashlogyPaymentAmounts: transaction => transaction,
    },
    '../../tables/service.ts': tables,
  },{ JSON })
  const input = part => ({ context,session:{ id:session },target:configured.id,action:'equal_part',sequence:part,
    draft:{ ticket:{ id:uuid(400+part),totalCents:part === 2 ? 1002 : 334 },sale:{ id:uuid(410+part),tenantId:tenant,totalCents:part === 2 ? 1002 : 334,paymentMethod:part === 1 ? 'card' : 'cash' },
      payment:{ id:uuid(420+part),amountCents:334,receivedCents:part === 1 ? null : 400,changeCents:part === 1 ? 0 : 66 },
      lines:part === 2 ? [{ id:'line',quantity:2,unitPriceCents:501,lineTotalCents:1002 }] : [] },
    params:{ splitId:configured.id,singleTicket:true,finalPart:part === 2,amountCents:334,expectedPaidParts:part,method:part === 1 ? 'card' : 'cash',receivedCents:part === 1 ? null : 400,allowPending:false,discount:null,useDefaultDiscount:true } })
  const first = await service.payRestaurantSale(input(0))
  assert.equal(first.result.split.paidParts,1)
  assert.equal(first.payload,null)
  await assert.rejects(service.payRestaurantSale(input(1)),/Response lost/)
  assert.equal((await db.query('select paid_parts from public.restaurant_order_equal_splits')).rows[0].paid_parts,2)
  const second = await service.payRestaurantSale(input(1))
  assert.equal(second.result.split.paidParts,2)
  assert.equal(second.payload,null)
  assert.equal((await durable.loadDurableSessionTickets(context,session)).length,0)
  const last = await service.payRestaurantSale(input(2))
  assert.equal(last.result.completed,true)
  assert.equal(last.payload.sale.totalCents,1002)
  assert.deepEqual(last.payload.payments.map(payment => payment.method),['cash','card','cash'])
  assert.deepEqual(charges,[334,334])
  assert.equal(new Set(rpcIds).size,3)
  assert.equal(rpcIds[1],rpcIds[2])
  assert.equal((await durable.loadDurableSessionTickets(context,session)).length,1)
  assert.equal((await db.query('select count(*)::int as n from public.sales')).rows[0].n,1)
})

test('production issues one invoice for the full total while Cashlogy charges only the final share', async () => {
  globalThis.indexedDB = new IDBFactory()
  globalThis.window = { location: { pathname: '/pos' } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: (_key,_options,work) => work() } } })
  const context = { tenantId: tenant, venueId: venue, deviceId: device, userId: user }
  const cashSession = { id: session }
  let invoices = 0, preflights = 0
  const charged = []
  const service = compileComponent(readFileSync(new URL('../src/features/restaurant/services/payment.ts',import.meta.url),'utf8'), {
    './checkout.ts': { prepareRestaurantCheckout: async () => {}, releaseRestaurantCheckout: async () => true, startRestaurantCheckout: async () => {} },
    './paymentPayload.ts': { withConfirmedRestaurantPayments },
    '../../../lib/durableSales.ts': durable,
    '../../fiscal/local/tenantMode.ts': { resolveLocalFiscalMode: async () => 'verifactu' },
    '../../fiscal/local/posInvoice.ts': { preflightPosInvoice: async () => { preflights++; return {} } },
    '../../local-printing/cashlogy/useCashlogyStore.ts': {
      isCashlogyPaymentConfigured: () => true,
      settleCashlogyPaymentIfConfigured: async amount => { charged.push(amount); return { requestedAmountCents: amount, receivedCents: amount, changeCents: 0, requestId: `request-${charged.length}`, id: `transaction-${charged.length}` } },
      getCashlogyPaymentAmounts: transaction => transaction,
    },
    '../../tables/service.ts': { payRestaurantIdempotent: async () => ({ singleTicket: true, completed: false, ticketId: null, saleId: null }) },
    '../../fiscal/local/restaurantInvoice.ts': { issueRestaurantInvoice: async (_context,_session,payload) => {
      invoices++
      assert.equal(payload.sale.totalCents, 1002)
      return { payload: { ...payload, localFiscal: { recordId: 'fiscal' } }, result: { ticketId: payload.ticket.id, saleId: payload.sale.id, paymentId: 'last', singleTicket: true, completed: true,
        payments: [0,1,2].map(n => ({ id: `pay-${n}`, tenantId: tenant, saleId: payload.sale.id, method: 'cash', amountCents: 334, receivedCents: 334, changeCents: 0 })) } }
    } },
  }, { JSON })
  const input = finalPart => ({ context, session: cashSession, action: 'equal_part', target: 'new-split', sequence: finalPart ? 2 : 0,
    draft: { ticket: { id: 'ticket', totalCents: finalPart ? 1002 : 334 }, sale: { id: finalPart ? 'final-sale' : 'first-sale', tenantId: tenant, totalCents: finalPart ? 1002 : 334, paymentMethod: 'cash' },
      payment: { id: 'draft-pay', amountCents: 334, receivedCents: 334, changeCents: 0 }, lines: [] },
    params: { singleTicket: true, finalPart, amountCents: 334, expectedPaidParts: finalPart ? 2 : 0, method: 'cash' } })
  const first = await service.payRestaurantSale(input(false))
  assert.equal(first.payload, null)
  assert.equal(invoices, 0)
  assert.equal(preflights, 0)
  const last = await service.payRestaurantSale(input(true))
  assert.equal(last.payload.payments.length, 3)
  assert.equal(invoices, 1)
  assert.equal(preflights, 1)
  assert.deepEqual(charged, [334,334])
})
