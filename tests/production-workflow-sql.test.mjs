import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createProductionDatabase, uuid, tenant, venue, pos, kds, destination, pass, order, line, product, user } from './helpers/production-db.mjs'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const fix = read('supabase/migrations/20261017120335_production_kds_workflow_fixes.sql')

test('production workflow migration passes the safe expansion checker', () => assert.deepEqual(analyzeMigration(fix), []))

test('SQL sends only new units after direct service, never repeats them, preserves readiness and enforces KDS scope', async t => {
  const db = await createProductionDatabase(t)
  const state = async (id = order) => (await db.query('select get_order_production_state($1) as value', [id])).rows[0].value
  const send = async (request, selection = null, revision = 1, device = pos) => (await db.query('select send_production_batch($1,$2,$3,$4,$5) as value', [order, revision, device, request, selection])).rows[0].value
  assert.equal((await state()).entries[0].unsentQuantity, 1)
  await assert.rejects(send('too-many', [{ lineId: line, quantity: 2 }]), /ya no está disponible/)
  await assert.rejects(send('stale', null, 2), /otro dispositivo/)
  await assert.rejects(send('kds-send', null, 1, kds), /no puede enviar/)
  const first = await send('first')
  assert.equal(first.sentUnits, 1)
  assert.equal((await state()).entries[0].unsentQuantity, 0)
  assert.equal((await state()).entries[0].skippedQuantity, 4)
  assert.equal((await send('first')).duplicate, true)
  await assert.rejects(send('repeat'), /No hay productos nuevos/)
  assert.equal((await db.query('select count(*)::int n from production_items')).rows[0].n, 1)
  await db.exec('update production_line_allocations set ready_quantity=quantity; update production_items set ready_quantity=quantity;')
  assert.equal((await state()).lines[0].readyQuantity, 1, 'old direct service must not hide newly prepared units')
  await db.exec(`update order_lines set quantity=6 where id='${line}'`)
  const second = await send('second')
  assert.equal(second.sentUnits, 1)
  assert.equal(second.sequence, 2)
  assert.equal((await state()).entries[0].unsentQuantity, 0)
  const queue = async (device = kds) => (await db.query('select get_kds_queue($1) value', [device])).rows[0].value
  assert.equal((await queue()).items.length, 1, 'prepared units leave the queue but later sends remain')
  const event = uuid(20)
  await db.exec(`insert into production_events values('${event}','${tenant}','${venue}','${destination}','cancelled',1,'{"productName":"Old cancellation"}',now(),null);
    insert into production_events values('${uuid(21)}','${uuid(99)}','${venue}','${destination}','cancelled',1,'{}',now(),null);
    insert into production_events values('${uuid(22)}','${tenant}','${venue}','${uuid(99)}','cancelled',1,'{}',now(),null);`)
  assert.equal((await queue()).events.length, 1)
  await db.exec('set role anon')
  await assert.rejects(db.query('select acknowledge_kds_event($1,$2)', [kds, event]), /permission denied/)
  await db.exec('set role authenticated')
  const ack = (device = kds, eventId = event) => db.query('select acknowledge_kds_event($1,$2)', [device, eventId])
  await assert.rejects(ack(pos), /no puede modificar/)
  await assert.rejects(ack(kds, uuid(21)), /no disponible/)
  await assert.rejects(ack(kds, uuid(22)), /no disponible/)
  await ack()
  await ack()
  assert.equal((await queue()).events.length, 0)
  await db.exec('reset role')
  assert.equal((await db.query('select count(*)::int n from production_events')).rows[0].n, 3, 'acknowledgement preserves audit history')
  await db.exec(`select set_config('test.uid','${uuid(99)}',false)`)
  await assert.rejects(ack(), /no puede modificar/)
  await assert.rejects(queue(), /no está activa/)
  await db.exec(`select set_config('test.uid','${user}',false); update devices set is_active=false where id='${kds}'`)
  await assert.rejects(ack(), /no puede modificar/)
  await db.exec(`update devices set is_active=true where id='${kds}'; select set_config('test.production','false',false)`)
  await assert.rejects(ack(), /no puede modificar/)
  await db.exec("select set_config('test.production','true',false)")

  // The same direct-service baseline must be tracked per menu component.
  const menu = uuid(30)
  await db.query(`insert into order_lines(id,tenant_id,venue_id,order_id,product_id,product_name,quantity,served_quantity,components)
    values($1,$2,$3,$4,$5,'Menu',3,2,$6)`, [menu, tenant, venue, order, product, [{ id: 'a', productId: product, productName: 'Burger', quantity: 2 }, { id: 'b', productId: product, productName: 'Side', quantity: 1 }]])
  await db.exec(`insert into order_line_production_passes(tenant_id,venue_id,order_line_id,component_id,pass_id,pass_name)
    values('${tenant}','${venue}','${menu}','a','${pass}','Directo'),('${tenant}','${venue}','${menu}','b','${pass}','Directo')`)
  assert.equal((await send('menu')).itemCount, 2)
  assert.deepEqual((await db.query('select quantity::float8 n from production_items where source_order_line_id=$1 order by source_component_id', [menu])).rows.map(row => row.n), [2, 1])
  assert.ok((await state()).entries.filter(entry => entry.lineId === menu).every(entry => entry.unsentQuantity === 0 && entry.skippedQuantity === 2))
  await assert.rejects(send('menu-repeat'), /No hay productos nuevos/)

  // The actual trigger chain moves directly served units before sent allocations.
  const split = uuid(40)
  await db.exec(`insert into order_lines(id,tenant_id,venue_id,order_id,product_name,quantity,served_quantity,split_from_line_id)
    values('${split}','${tenant}','${venue}','${order}','Absolut',2,2,'${line}');
    update order_lines set quantity=4,served_quantity=2 where id='${line}';`)
  const skipped = (await db.query('select order_line_id,skipped_quantity::float8 n from order_line_production_passes where component_id=\'\' order by order_line_id')).rows
  assert.deepEqual(skipped.map(row => row.n), [2, 2])
  assert.ok((await state()).entries.every(entry => entry.unsentQuantity === 0))
  assert.equal((await state()).lines.reduce((sum, line) => sum + Number(line.readyQuantity), 0), 1, 'splitting must not invent ready units')
  await db.query('update order_lines set quantity=4 where id=$1', [menu])
  await send('menu-extra')
  const menuSplit = uuid(41)
  await db.query(`insert into order_lines(id,tenant_id,venue_id,order_id,product_name,quantity,served_quantity,components,split_from_line_id)
    select $1,tenant_id,venue_id,order_id,product_name,3,2,components,id from order_lines where id=$2`, [menuSplit, menu])
  await db.query('update order_lines set quantity=1,served_quantity=0 where id=$1', [menu])
  assert.ok((await state()).entries.every(entry => entry.unsentQuantity === 0))
  assert.equal((await db.query('select sum(quantity)::float8 n from production_component_allocations where current_order_line_id=$1', [menuSplit])).rows[0].n, 2)

  // Exercise the actual template interpolator, both overloads, and decimal trimming.
  const templateSource = read('supabase/migrations/20260902150000_add_print_templates.sql')
  for (const name of ['print_template_value', 'print_template_interpolate']) {
    await db.exec(templateSource.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0])
  }
  for (const [quantity, expected] of [['3.000', '3'], ['1.500', '1,5'], ['0.125', '0,125'], ['12.010', '12,01']]) {
    const result = (await db.query(`select production_item_lines($1,$2::numeric) lines,
      print_template_interpolate('{{quantity}}x {{name}}','{}',production_item_print_context($1,$2::numeric)) rendered`, [{ productName: 'Bravas' }, quantity])).rows[0]
    assert.equal(result.lines[0], `${expected}x Bravas`)
    assert.equal(result.rendered, `${expected}x Bravas`)
  }
  assert.equal((await db.query("select production_item_print_context('{}',3::integer)->>'quantity' value")).rows[0].value, '3')
})

