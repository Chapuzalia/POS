import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, hash } from '../apps/api/src/app.ts'
import { createTickitDatabase, ids, uuid } from './helpers/tickit-db.mjs'

test('Express API uses real atomic SQL: catalog, sessions, append, retries and revocation', async (t) => {
  const { db, configure } = await createTickitDatabase(t)
  await db.exec("update tenant_memberships set role='manager'")
  await assert.rejects(
    () => db.query('select tickit_carta_configure($1,true)', [ids.venue]),
    /FORBIDDEN/,
  )
  await db.exec("update tenant_memberships set role='owner'")
  const signatures = {
    tickit_api_auth: ['text'],
    tickit_api_capabilities: ['uuid'],
    tickit_api_catalog: ['uuid'],
    tickit_api_table_link: ['uuid', 'uuid'],
    tickit_api_session: ['uuid', 'text', 'text'],
    tickit_api_submit: ['uuid', 'text', 'uuid', 'jsonb'],
  }
  const calls = []
  const rpc = async (name, args) => {
    assert.ok(name in signatures)
    calls.push({ name, args })
    try {
      const values = Object.values(args).map((v) => (typeof v === 'object' ? JSON.stringify(v) : v))
      const params = signatures[name].map((type, i) => `$${i + 1}::${type}`).join(',')
      const result = await db.query(`select public.${name}(${params}) result`, values)
      return { data: result.rows[0].result, error: null }
    } catch (error) {
      return { data: null, error: { message: error.message, code: error.code } }
    }
  }
  const server = createApp({ rpc }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = {
    Authorization: `Bearer ${configure.apiKey}`,
    'Content-Type': 'application/json',
  }
  const post = (path, body) =>
    fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
  await db.exec('set role authenticated')
  await assert.rejects(
    () => db.query('select tickit_api_auth($1)', [hash(configure.apiKey)]),
    /permission denied/,
  )
  await assert.rejects(
    () => db.query('select tickit_api_table_link($1,$2)', [configure.integrationId, ids.table]),
    /permission denied/,
  )
  await db.exec('reset role')
  assert.equal((await fetch(base + '/v1/catalog')).status, 401)
  assert.equal(
    (
      await fetch(base + '/v1/catalog', {
        headers: { Authorization: 'Bearer tk_' + 'f'.repeat(64) },
      })
    ).status,
    401,
  )
  const caps = await (await fetch(base + '/v1/capabilities', { headers })).json()
  assert.equal(caps.venueId, ids.venue)
  const catalog = await (await fetch(base + '/v1/catalog', { headers })).json()
  assert.equal(catalog.products[0].name, 'Plato')
  assert.equal(catalog.variants[0].price_cents, 1234)
  assert.ok(!JSON.stringify(catalog).includes(configure.apiKey))
  const linkResponse = await post('/v1/table-links', { tableId: ids.table })
  assert.equal(linkResponse.status, 200, await linkResponse.clone().text())
  const link = await linkResponse.json()
  assert.equal(link.tableName, 'Mesa 1')
  assert.equal((await post('/v1/table-links', { tableId: uuid(999) })).status, 403)
  assert.equal(
    (await post('/v1/table-links', { tableId: ids.table, venueId: ids.venue })).status,
    422,
  )
  assert.equal((await post('/v1/sessions', { tableToken: 'f'.repeat(64) })).status, 409)
  const sessionResponse = await post('/v1/sessions', { tableToken: link.tableToken })
  assert.equal(sessionResponse.status, 201, await sessionResponse.clone().text())
  const session = await sessionResponse.json()
  assert.equal(session.occupationId, ids.group)
  const body = {
    sessionToken: session.token,
    idempotencyKey: uuid(101),
    lines: [
      {
        productId: ids.product,
        variantId: ids.variant,
        quantityMilli: 1500,
        modifierOptionIds: [ids.modifier],
      },
    ],
  }
  const foreignKey = 'tk_' + 'b'.repeat(64)
  await db.query('insert into tenants values($1)', [uuid(201)])
  await db.query('insert into venues values($1,$2)', [uuid(202), uuid(201)])
  await db.query(
    'insert into tickit_private.integrations(id,tenant_id,venue_id,key_hash) values($1,$2,$3,$4)',
    [uuid(203), uuid(201), uuid(202), hash(foreignKey)],
  )
  const foreignResponse = await fetch(base + '/v1/orders', {
    method: 'POST',
    headers: { ...headers, Authorization: `Bearer ${foreignKey}` },
    body: JSON.stringify(body),
  })
  assert.equal(foreignResponse.status, 409)
  assert.equal(
    (
      await fetch(base + '/v1/table-links', {
        method: 'POST',
        headers: { ...headers, Authorization: `Bearer ${foreignKey}` },
        body: JSON.stringify({ tableId: ids.table }),
      })
    ).status,
    403,
  )
  const invalid = structuredClone(body)
  invalid.lines[0].unitPriceCents = 1
  assert.equal((await post('/v1/orders', invalid)).status, 422)
  // An existing staff line must keep its edited price, quantity and snapshot.
  await db.query(
    `insert into order_lines(id,tenant_id,venue_id,order_id,product_name,variant_name,unit_price_cents,quantity,catalog_snapshot) values($1,$2,$3,$4,'Personal','',700,2,'{"historical":true}')`,
    [uuid(100), ids.tenant, ids.venue, ids.order],
  )
  const response = await post('/v1/orders', body)
  assert.equal(response.status, 200, await response.clone().text())
  const receipt = await response.json()
  assert.equal(receipt.totalCents, 1895) // (1234 + 29) * 1.5 rounded once per line
  assert.equal(receipt.productionStatus, 'saved')
  const duplicates = await Promise.all([post('/v1/orders', body), post('/v1/orders', body)])
  for (const duplicate of duplicates) assert.deepEqual(await duplicate.json(), receipt)
  const lines = (await db.query('select * from order_lines order by product_name')).rows
  assert.equal(lines.length, 2)
  const staff = lines.find((l) => l.id === uuid(100))
  assert.equal(staff.unit_price_cents, 700)
  assert.deepEqual(staff.catalog_snapshot, { historical: true })
  assert.equal((await db.query('select revision from orders')).rows[0].revision, 1)
  const changed = structuredClone(body)
  changed.lines[0].quantityMilli = 2000
  assert.equal((await post('/v1/orders', changed)).status, 409)
  const bad = structuredClone(body)
  bad.idempotencyKey = uuid(102)
  bad.lines.push({ ...bad.lines[0], variantId: uuid(999) })
  assert.equal((await post('/v1/orders', bad)).status, 422)
  assert.equal((await db.query('select count(*)::int n from order_lines')).rows[0].n, 2)
  const foreign = structuredClone(body)
  foreign.idempotencyKey = uuid(103)
  foreign.lines[0].productId = uuid(998)
  assert.equal((await post('/v1/orders', foreign)).status, 422)
  await db.exec(`update orders set status='paid',closed_at=now()`)
  assert.equal((await post('/v1/orders', { ...body, idempotencyKey: uuid(104) })).status, 409)
  assert.deepEqual(await (await post('/v1/orders', body)).json(), receipt)
  assert.equal((await post('/v1/sessions', { tableToken: link.tableToken })).status, 409)
  await db.query('select tickit_carta_configure($1,false)', [ids.venue])
  assert.equal((await fetch(base + '/v1/catalog', { headers })).status, 401)
  assert.equal((await post('/v1/table-links', { tableId: ids.table })).status, 401)
  assert.ok(
    calls.some((c) => c.name === 'tickit_api_auth' && c.args.p_key_hash === hash(configure.apiKey)),
  )

  // Menu components use authoritative supplements and validate their own required modifiers.
  await db.exec("update orders set status='open',closed_at=null")
  const renewed = (await db.query('select tickit_carta_configure($1,true) result', [ids.venue]))
    .rows[0].result
  headers.Authorization = `Bearer ${renewed.apiKey}`
  assert.equal((await post('/v1/orders', { ...body, idempotencyKey: uuid(105) })).status, 409)
  const newSession = await (await post('/v1/sessions', { tableToken: link.tableToken })).json()
  const x = ids
  await db.exec(`insert into products(id,tenant_id,venue_id,name) values('${uuid(301)}','${x.tenant}','${x.venue}','Guarnición');
    insert into product_variants(id,tenant_id,venue_id,product_id,name,price_cents,is_default) values('${uuid(302)}','${x.tenant}','${x.venue}','${uuid(301)}','Normal',500,true);
    insert into selection_groups(id,tenant_id,venue_id,kind,name) values('${uuid(303)}','${x.tenant}','${x.venue}','menu_component','Guarnición');
    insert into selection_group_options(id,tenant_id,venue_id,group_id,product_id,variant_id,supplement_cents) values('${uuid(304)}','${x.tenant}','${x.venue}','${uuid(303)}','${uuid(301)}','${uuid(302)}',100);
    insert into product_selection_group_assignments(id,tenant_id,venue_id,product_id,group_id,min_selection,max_selection) values('${uuid(305)}','${x.tenant}','${x.venue}','${x.product}','${uuid(303)}',1,1);
    insert into product_modifier_group_assignments(id,tenant_id,venue_id,product_id,group_id,min_selection,max_selection) values('${uuid(306)}','${x.tenant}','${x.venue}','${uuid(301)}','${x.modifierGroup}',1,1);`)
  const menu = {
    sessionToken: newSession.token,
    idempotencyKey: uuid(307),
    lines: [
      {
        productId: x.product,
        variantId: x.variant,
        quantityMilli: 2000,
        modifierOptionIds: [],
        components: [],
      },
    ],
  }
  assert.equal((await post('/v1/orders', menu)).status, 422)
  menu.lines[0].components = [
    {
      id: uuid(304),
      selectionGroupId: uuid(303),
      productId: uuid(301),
      variantId: uuid(302),
      quantity: 1,
      modifiers: [],
    },
  ]
  assert.equal((await post('/v1/orders', menu)).status, 422)
  menu.lines[0].components[0].modifiers = [{ id: x.modifier }]
  const menuResponse = await post('/v1/orders', menu)
  assert.equal(menuResponse.status, 200, await menuResponse.clone().text())
  assert.equal((await menuResponse.json()).totalCents, 2726)
  assert.equal((await db.query('select count(*)::int n from order_line_components')).rows[0].n, 1)
  await db.query(
    "update tickit_private.sessions set expires_at=now()-interval '1 second' where token_hash=$1",
    [hash(newSession.token)],
  )
  assert.equal((await post('/v1/orders', { ...menu, idempotencyKey: uuid(308) })).status, 409)
  const rotated = await (await post('/v1/table-links', { tableId: ids.table })).json()
  assert.notEqual(rotated.tableToken, link.tableToken)
  assert.equal((await post('/v1/sessions', { tableToken: link.tableToken })).status, 409)
  assert.equal((await post('/v1/sessions', { tableToken: rotated.tableToken })).status, 201)
})

test('new migration is an additive production-compatible expansion', async () => {
  const { readFileSync } = await import('node:fs')
  const { analyzeMigration } = await import('../scripts/check-migrations.mjs')
  for (const migration of [
    '20261017234914_tickit_carta_api.sql',
    '20261018001409_tickit_carta_table_links_api.sql',
  ]) {
    const source = readFileSync(
      new URL(`../supabase/migrations/${migration}`, import.meta.url),
      'utf8',
    )
    assert.deepEqual(analyzeMigration(source), [], migration)
  }
})
