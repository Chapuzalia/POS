import assert from 'node:assert/strict'
import test from 'node:test'

import { venueRestaurantDb, ids, uuid } from './helpers/venue-restaurant-db.mjs'

test('item payments in different checkouts retain their own session and exact source lines', async t => {
  const { db,query,open,addLines,pay } = await venueRestaurantDb()
  t.after(() => db.close())
  const orderId = await open()
  await addLines(orderId)
  const first = await pay(orderId,{ moves:[{ lineId:ids.line,quantity:1 }] },ids.deviceB,uuid(80),'selected_items')
  const second = await pay(orderId,{ expectedRevision:first.revision,moves:[{ lineId:ids.line,quantity:1 }] },ids.deviceA,uuid(81),'selected_items')
  const rows = await query('select cash_session_id,total_cents from sales order by cash_session_id')
  assert.deepEqual(rows,[{ cash_session_id:ids.sessionA,total_cents:500 },{ cash_session_id:ids.sessionB,total_cents:500 }])
  assert.notEqual(first.saleId,second.saleId)
  assert.equal((await query('select sum(line_total_cents)::integer as total from ticket_lines where source_order_line_id=$1',[ids.line]))[0].total,1000)
})

test('an active checkout reservation blocks another checkout, edits and close until its original payment is recovered', async t => {
  const { db,query,open,addLines,pay } = await venueRestaurantDb()
  t.after(() => db.close())
  const orderId = await open()
  await addLines(orderId)
  const params = { orderId,expectedRevision:0,method:'card',allowPending:true,cashSessionId:ids.sessionB }
  await query("select prepare_restaurant_checkout($1,$2,$3,$4,'close',$5)",[uuid(60),ids.tenant,ids.venue,ids.deviceB,params])
  await assert.rejects(pay(orderId,{},ids.deviceA,uuid(61)),/cobro en curso/)
  await assert.rejects(query('update order_lines set quantity=3 where order_id=$1',[orderId]),/cobro en curso/)
  await assert.rejects(query("select close_cash_register_session($1,$2,'{}')",[ids.sessionB,ids.deviceB]),/cobros en curso/)
  await query('select start_restaurant_checkout($1,$2)',[uuid(60),ids.deviceB])
  assert.equal((await query('select release_restaurant_checkout($1,$2) as released',[uuid(60),ids.deviceB]))[0].released,false)
  assert.equal((await query('select active from restaurant_checkout_claims where operation_id=$1',[uuid(60)]))[0].active,true)
  await pay(orderId)
  await query("select close_cash_register_session($1,$2,'{}')",[ids.sessionB,ids.deviceB])
})

test('checkout and map scope reject other venues, devices and stale order revisions', async t => {
  const { db,query,open,addLines,pay } = await venueRestaurantDb()
  t.after(() => db.close())
  const orderId = await open()
  await addLines(orderId)
  await assert.rejects(query('select get_venue_table_layout($1)',[ids.otherVenue]),/Local no disponible/)
  await assert.rejects(pay(orderId,{ expectedRevision:99 }),/ha cambiado/)
  await assert.rejects(pay(orderId,{ cashSessionId:ids.sessionA }),/Selecciona una caja/)
  await query('update devices set can_take_payments=false where id=$1',[ids.deviceB])
  await assert.rejects(pay(orderId),/no puede cobrar/)
  assert.equal((await query('select count(*)::integer as count from sales'))[0].count,0)
  await query('insert into venue_table_layouts(tenant_id,venue_id) values($1,$2)',[ids.otherTenant,ids.otherVenue])
  await db.exec('set role authenticated')
  assert.equal((await query('select count(*)::integer as count from venue_table_layouts where venue_id=$1',[ids.otherVenue]))[0].count,0)
})

test('a fiscal payment created in B preserves the invoice installation and replays after closing B', async t => {
  const { db,query,open,addLines } = await venueRestaurantDb()
  t.after(() => db.close())
  const orderId = await open()
  await addLines(orderId)
  const subject = uuid(300),installation = uuid(301),recordId = uuid(302),invoiceId = uuid(303)
  await query("insert into fiscal_subjects values($1,$2,'B12345678')",[subject,ids.tenant])
  await query("insert into fiscal_sif_installations values($1,$2,$3,$4,$5,$6,null,'production','L1','C2','I1',2,1)",
    [installation,ids.tenant,subject,ids.venue,ids.registerB,ids.deviceB])
  await query("select close_cash_register_session($1,$2,'{}')",[ids.sessionA,ids.deviceA])
  const issuedAt = new Date().toISOString()
  const date = (await query("select to_char($1::timestamptz at time zone 'Europe/Madrid','DD-MM-YYYY') as date",[issuedAt]))[0].date
  const series = `L1-C2-1-${date.slice(-4)}-S`,hash = 'A'.repeat(64)
  const record = { tenantId:ids.tenant,venueId:ids.venue,cashRegisterId:ids.registerB,deviceId:ids.deviceB,
    fiscalSubjectId:subject,installationId:installation,idempotencyKey:recordId,invoiceId,issuerNif:'B12345678',environment:'production',
    generatedAt:issuedAt,canonicalSchema:'aeat-registro-v1',chainPosition:1,hash,previous:null,lease:{ fencingToken:1 },
    canonicalRecord:{ RegistroAlta:{ TipoFactura:'F2',Huella:hash,ImporteTotal:'10.00',FechaHoraHusoGenRegistro:issuedAt,
      IDFactura:{ IDEmisorFactura:'B12345678',NumSerieFactura:`${series}/1`,FechaExpedicionFactura:date },Encadenamiento:{ PrimerRegistro:'S' } } } }
  const params = { orderId,cashSessionId:ids.sessionB,paymentOperationId:uuid(304),expectedRevision:0,method:'card',allowPending:true }
  const invoice = { invoiceId,series,number:1,issuedAt,totalCents:1000 }
  const issue = async () => (await query("select pay_restaurant_local_fiscal('close',$1,$2,$3) as result",[params,record,invoice]))[0].result
  const first = await issue()
  assert.equal((await query('select cash_session_id from sales where id=$1',[first.saleId]))[0].cash_session_id,ids.sessionB)
  await query("select close_cash_register_session($1,$2,'{}')",[ids.sessionB,ids.deviceB])
  assert.deepEqual(await issue(),first)
  assert.equal((await query('select count(*)::integer as n from fiscal_local_records'))[0].n,1)
})
