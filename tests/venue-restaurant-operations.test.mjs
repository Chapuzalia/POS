import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { venueRestaurantDb,ids,uuid,migration } from './helpers/venue-restaurant-db.mjs'

test('venue restaurant migration retains the supported deployment contract', () => {
  assert.deepEqual(analyzeMigration(migration),[])
})

test('both checkouts share layout revisions and closing the origin leaves physical and virtual orders available', async t => {
  const { db,query,open,addLines,pay } = await venueRestaurantDb()
  t.after(() => db.close())
  const { venue,table,sessionA,sessionB,deviceA,deviceB } = ids
  const layout = (await query('select get_venue_table_layout($1) as result',[venue]))[0].result
  const updated = { ...layout.tables,[table]:{ positionX:30,positionY:20,groupId:null } }
  await query('select save_venue_table_layout($1,$2,$3)',[venue,layout.revision,updated])
  const fromB = (await query('select get_cash_session_table_layout($1) as result',[sessionB]))[0].result
  assert.equal(fromB.tables[table].positionX,30)
  await assert.rejects(query('select save_venue_table_layout($1,$2,$3)',[venue,layout.revision,updated]),/distribución ha cambiado/)
  await assert.rejects(query('select save_venue_table_layout($1,null,$2)',[venue,updated]),/distribución ha cambiado/)
  await assert.rejects(query('select save_venue_table_layout($1,$2,$3)',[venue,fromB.revision,{ [table]:{ groupId:null } }]),/posición no válida/)
  const orderId = await open()
  await addLines(orderId)
  await query('update order_lines set catalog_snapshot=$1 where order_id=$2',[{ categoryId:uuid(150),categoryName:'Histórica' },orderId])
  const virtualId = (await query("select create_virtual_restaurant_table($1,$2,null,'Pendiente',2,'square') as id",[sessionA,deviceA]))[0].id
  await query('select open_restaurant_order(array[$1::uuid],2,$2,$3)',[virtualId,sessionB,deviceB])
  await query("select close_cash_register_session($1,$2,'{}')",[sessionA,deviceA])
  assert.equal((await query('select status from orders where id=$1',[orderId]))[0].status,'open')
  assert.equal((await query('select is_active from restaurant_tables where id=$1',[virtualId]))[0].is_active,true)
  const map = (await query('select pos_restaurant_map($1,$2,$3,false) as result',[ids.tenant,venue,sessionB]))[0].result
  assert.ok(map.tables.some(row => row.id === virtualId))
  assert.equal(map.layout.tables[table].positionX,30)
  const paid = await pay(orderId)
  const sale = (await query('select * from sales where id=$1',[paid.saleId]))[0]
  assert.equal(sale.cash_session_id,sessionB)
  assert.equal(sale.cash_register_id,ids.registerB)
  assert.equal(sale.device_id,deviceB)
  assert.equal((await query('select cash_session_id from orders where id=$1',[orderId]))[0].cash_session_id,sessionA)
  assert.equal((await query('select count(*)::integer as count from ticket_lines where source_order_line_id=$1',[ids.line]))[0].count,1)
  assert.equal((await query('select category_name_snapshot from ticket_lines where source_order_line_id=$1',[ids.line]))[0].category_name_snapshot,'Histórica')
  assert.equal((await pay(orderId)).saleId,paid.saleId)
  assert.equal((await query('select count(*)::integer as count from sales'))[0].count,1)
})

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

test('layout membership follows CRM activation and a temporary table created in A can be removed from B', async t => {
  const { db,query } = await venueRestaurantDb()
  t.after(() => db.close())
  await query('select get_venue_table_layout($1)',[ids.venue])
  await query('update restaurant_tables set is_active=false where id=$1',[ids.table])
  let layout = (await query('select get_venue_table_layout($1) as result',[ids.venue]))[0].result
  assert.equal(layout.tables[ids.table],undefined)
  await query('update restaurant_tables set is_active=true where id=$1',[ids.table])
  layout = (await query('select get_venue_table_layout($1) as result',[ids.venue]))[0].result
  assert.ok(layout.tables[ids.table])
  const virtual = (await query("select create_virtual_restaurant_table($1,$2,null,'Temporal',2,'square') as id",[ids.sessionA,ids.deviceA]))[0].id
  await query('select delete_session_virtual_restaurant_table($1,$2,$3)',[ids.sessionB,ids.deviceB,virtual])
  assert.equal((await query('select count(*)::integer as n from restaurant_tables where id=$1',[virtual]))[0].n,0)
  assert.equal((await query('select get_venue_table_layout($1) as result',[ids.venue]))[0].result.tables[virtual],undefined)
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

test('confirmed hardware cancellation releases only its own active claim and never revives the cancelled operation', async t => {
  const { db,query,open,addLines,pay } = await venueRestaurantDb()
  t.after(() => db.close())
  const orderId = await open()
  await addLines(orderId)
  const params = { orderId,expectedRevision:0,method:'card',allowPending:true,cashSessionId:ids.sessionB }
  await query("select prepare_restaurant_checkout($1,$2,$3,$4,'close',$5)",[uuid(60),ids.tenant,ids.venue,ids.deviceB,params])
  await query('select start_restaurant_checkout($1,$2)',[uuid(60),ids.deviceB])
  await assert.rejects(query('select cancel_restaurant_checkout($1,$2)',[uuid(60),ids.deviceA]),/Cobro no disponible/)
  await query('select cancel_restaurant_checkout($1,$2)',[uuid(60),ids.deviceB])
  await assert.rejects(pay(orderId),/se canceló/)
  const result = await pay(orderId,{},ids.deviceA,uuid(61))
  await query('select cancel_restaurant_checkout($1,$2)',[uuid(61),ids.deviceA])
  assert.equal((await pay(orderId,{},ids.deviceA,uuid(61))).saleId,result.saleId)
})

test('single-ticket shares settle in the collecting checkout and only that checkout is blocked from closing', async t => {
  const { db,query,open,addLines,pay } = await venueRestaurantDb()
  t.after(() => db.close())
  const orderId = await open()
  await addLines(orderId)
  const split = (await query('select configure_restaurant_equal_split_single($1,2,0,null) as result',[orderId]))[0].result
  const params = { splitId:split.id,singleTicket:true,expectedPaidParts:0,finalPart:false }
  await pay(orderId,params,ids.deviceB,uuid(70),'equal_part')
  await query("select close_cash_register_session($1,$2,'{}')",[ids.sessionA,ids.deviceA])
  await assert.rejects(query("select close_cash_register_session($1,$2,'{}')",[ids.sessionB,ids.deviceB]),/repartos parcialmente cobrados/)
  await assert.rejects(pay(orderId,{ ...params,expectedPaidParts:1,finalPart:true },ids.deviceA,uuid(71),'equal_part'),/primer pago/)
  const final = await pay(orderId,{ ...params,expectedPaidParts:1,finalPart:true },ids.deviceB,uuid(72),'equal_part')
  assert.equal(final.completed,true)
  assert.equal((await query('select cash_session_id from sales where id=$1',[final.saleId]))[0].cash_session_id,ids.sessionB)
  await query("select close_cash_register_session($1,$2,'{}')",[ids.sessionB,ids.deviceB])
})

test('the migration refuses to run while any checkout is open', async t => {
  const { db } = await venueRestaurantDb({ apply:false })
  t.after(() => db.close())
  await assert.rejects(db.exec(migration),/Cierra todas las cajas/)
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
