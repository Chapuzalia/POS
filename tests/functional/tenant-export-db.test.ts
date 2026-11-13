import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createExportDb, exportSourceTables } from '../helpers/tenant-export-db.mjs'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [tenant, other, owner, stranger, manager, cashier, former] = [1,2,3,4,5,6,7].map(id)
let db: Awaited<ReturnType<typeof createExportDb>>
const call = async (collection: string | null = null, cursor: unknown = null, tid = tenant) => {
  const result = (await db.query('select public.export_tenant_data($1,$2,$3::jsonb) result', [tid, collection, cursor === null ? null : JSON.stringify(cursor)])).rows[0].result
  return result.rows ? { ...result, rows: result.rows.map((row: string) => JSON.parse(row)) } : result
}
async function as(user: string, role = 'authenticated') {
  await db.exec('reset role')
  await db.query("select set_config('test.uid',$1,false)", [user])
  await db.exec(`set role ${role}`)
}
beforeAll(async () => {
  db = await createExportDb(afterAll)
  await db.exec(`insert into tenants(id,name,is_active) values('${tenant}','Mi negocio',false),('${other}','Otro negocio',true);
    insert into profiles(id,full_name,is_superadmin) values('${owner}','Propietario',false),('${stranger}','Ajeno',true),('${manager}','Gerente',false),('${cashier}','Caja',false),('${former}','Antiguo empleado',false);
    insert into auth.users values('${owner}','owner@example.test'),('${stranger}','private@example.test'),('${former}','former@example.test');
    insert into tenant_memberships(id,tenant_id,user_id,role,is_active) values
      ('${id(20)}','${tenant}','${owner}','owner',true),('${id(21)}','${other}','${stranger}','owner',true),
      ('${id(22)}','${tenant}','${manager}','manager',true),('${id(23)}','${tenant}','${cashier}','cashier',true);
    insert into tickets(id,tenant_id,user_id,total_cents,ticket_number,customer_snapshot) values
      ('${id(30)}','${tenant}','${former}',1210,9007199254740993,'{"legal_name":"Histórico","precise":1234567890123456789.123456789}'),('${id(31)}','${other}','${stranger}',500,1,'{}');
    insert into product_variants(id,tenant_id,price_cents) values('${id(40)}','${tenant}',999);
    insert into inventory_stock_levels(warehouse_id,inventory_item_id,tenant_id,quantity) values('${id(41)}','${id(42)}','${tenant}',123456789.123456);
    insert into supplier_documents(id,tenant_id,global_profile_id,extraction_metadata,ocr_snapshot) values('${id(48)}','${tenant}','${id(49)}','{"internal":"NEVER_EXPORT"}',
      '{"text":"Texto del cliente","pages":[],"confidence":0.95,"provider":"PRIVATE_PROVIDER","metadata":{"secret":"NEVER_EXPORT"}}');
    insert into product_images(id,tenant_id,storage_path) values('${id(43)}','${tenant}','${tenant}/photo.webp'),('${id(44)}','${other}','${other}/photo.webp'),('${id(45)}','${tenant}','${other}/forged.webp');
    insert into production_print_agents(id,tenant_id,secret_hash) values('${id(51)}','${tenant}','NEVER_EXPORT');
    insert into production_agent_printers(agent_id,printer_id,tenant_id,display_name,paper_width,character_set) values('${id(51)}','printer','${tenant}','Cocina',80,'UTF-8');
    insert into storage.objects values('product-images','${tenant}/photo.webp'),('product-images','${other}/photo.webp'),('product-images','${other}/forged.webp');
    create table public.provider_secrets(tenant_id uuid,secret text);
    insert into provider_secrets values('${tenant}','NEVER_EXPORT');
    alter table products add column future_secret text;
    insert into products(id,tenant_id,name,future_secret) values('${id(46)}','${tenant}','Producto','NEVER_EXPORT');
    insert into catalog_audit_log(id,tenant_id,table_name,before_data,after_data) values(9007199254740993,'${tenant}','products','{"name":"Anterior","future_secret":"NEVER_EXPORT","tenant_id":"${tenant}"}','{"name":"Producto"}');`)
}, 30_000)
beforeEach(async () => { await as(owner) })

it('executes every collection against actual source column names and exposes no new columns automatically', async () => {
  const manifest = await call()
  expect(manifest.format).toBe('tickit-tenant-export')
  const published = JSON.parse(readFileSync(new URL('../../public/legal/export-schema-v1.json', import.meta.url), 'utf8'))
  const tables = exportSourceTables()
  expect(published.collections.filter((item: { name: string }) => tables.has(item.name)).map((item: { name: string }) => item.name)).toEqual(manifest.collections.map((item: { name: string }) => item.name))
  for (const collection of manifest.collections) {
    const schema = published.collections.find((item: { name: string }) => item.name === collection.name)
    const available = schema.columns.filter((item: { name: string }) => tables.get(collection.name)?.has(item.name) || (collection.name === 'profiles' && item.name === 'email'))
    expect(available.map((item: { name: string }) => item.name).sort()).toEqual(collection.columns.map((item: { name: string }) => item.name).sort())
  }
  const specs = (await db.query('select * from public.tenant_export_spec()')).rows
  for (const spec of specs) {
    if (!tables.has(spec.collection)) {
      expect(manifest.schemaChanges).toContainEqual({ collection: spec.collection, reason: 'table_unavailable' })
      await expect(call(spec.collection)).rejects.toThrow(/EXPORT_SCHEMA_CHANGED/)
      continue
    }
    const absent = spec.fields.split(',').filter((field: string) => !tables.get(spec.collection)?.has(field))
    if (absent.length) expect(manifest.schemaChanges).toContainEqual({ collection: spec.collection, reason: 'columns_unavailable', columns: absent })
    await expect(call(spec.collection)).resolves.toHaveProperty('rows')
  }
  expect(JSON.stringify(manifest)).not.toMatch(/future_secret|is_superadmin|storage_path|global_supplier|api_key/)
  expect((await call('products')).rows).toEqual([expect.objectContaining({ name: 'Producto' })])
  expect(JSON.stringify(await call('products'))).not.toContain('NEVER_EXPORT')
})

it('denies anonymous users, managers, cashiers, foreign owners and a superadmin without ownership', async () => {
  for (const user of ['', manager, cashier, stranger]) {
    await as(user)
    await expect(call()).rejects.toThrow(/EXPORT_FORBIDDEN/)
  }
  await as(owner, 'anon')
  await expect(call()).rejects.toThrow(/permission denied/)
  await as(owner)
  await expect(call(null,null,other)).rejects.toThrow(/EXPORT_FORBIDDEN/)
  await expect(call('provider_secrets')).rejects.toThrow(/EXPORT_UNKNOWN_COLLECTION/)
  await expect(call("tickets; select * from provider_secrets")).rejects.toThrow(/EXPORT_UNKNOWN_COLLECTION/)
})

it('preserves historical money, fiscal snapshots and decimal precision without leaking another business', async () => {
  const data = await call('tickets')
  expect(data.rows).toHaveLength(1)
  expect(data.rows[0]).toMatchObject({ total_cents: 1210, ticket_number: '9007199254740993', customer_snapshot: { legal_name: 'Histórico' } })
  const raw = (await db.query('select public.export_tenant_data($1,$2) result',[tenant,'tickets'])).rows[0].result
  expect(raw.rows[0]).toContain('1234567890123456789.123456789')
  expect((await call('inventory_stock_levels')).rows[0].quantity).toBe('123456789.123456')
  const people = (await call('profiles')).rows
  expect(people).toContainEqual(expect.objectContaining({ id: former, full_name: 'Antiguo empleado', email: 'former@example.test' }))
  expect(JSON.stringify(people)).not.toContain('private@example.test')
  expect(JSON.stringify(people)).not.toContain('is_superadmin')
  const audit = await call('catalog_audit_log')
  expect(audit.rows[0].before_data).toEqual({ name: 'Anterior' })
  expect(audit.next).toEqual(['9007199254740993'])
  const purchases = await call('supplier_documents')
  expect(purchases.rows[0].ocr_snapshot).toEqual({ text: 'Texto del cliente', pages: [], confidence: 0.95 })
  expect(JSON.stringify(purchases)).not.toMatch(/NEVER_EXPORT|PRIVATE_PROVIDER|global_profile_id/)
  expect(purchases.files).toEqual([])
  expect(JSON.stringify(await call('production_print_agents'))).not.toContain('NEVER_EXPORT')
  expect((await call('production_agent_printers')).rows[0]).toMatchObject({ display_name: 'Cocina', paper_width: 80 })
})

it('paginates more than 1000 records and compound keys without offsets or silent truncation', async () => {
  await db.exec('reset role')
  await db.exec(`insert into sales(id,tenant_id,total_cents) select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${tenant}',n from generate_series(1,1103) n`)
  await as(owner)
  const ids = []
  let cursor = null
  for (;;) {
    const page = await call('sales',cursor)
    if (!page.rows.length) break
    expect(page.rows.length).toBeLessThanOrEqual(500)
    ids.push(...page.rows.map((row: { id: string }) => row.id))
    cursor = page.next
  }
  expect(new Set(ids).size).toBe(1103)
  const compound = await call('inventory_stock_levels')
  expect((await call('inventory_stock_levels',compound.next)).rows).toEqual([])
  await expect(call('tickets',{})).rejects.toThrow(/EXPORT_INVALID_CURSOR/)
  await expect(call('tickets',[null])).rejects.toThrow(/EXPORT_INVALID_CURSOR/)
  await expect(call('tickets',[])).rejects.toThrow(/EXPORT_INVALID_CURSOR/)
})

it('does not compare normalized document bytes against the original input fingerprint', async () => {
  await db.exec('reset role; begin')
  try {
    await db.exec(`update supplier_documents set storage_bucket='supplier-documents',storage_path='${tenant}/document.webp',
      original_file_name='document.webp',original_mime_type='image/webp',file_hash=repeat('a',64) where id='${id(48)}'`)
    await as(owner)
    const documents = await call('supplier_documents')
    expect(documents.rows[0].file_hash).toBe('a'.repeat(64))
    expect(documents.files[0]).toMatchObject({ mimeType: 'image/webp', sha256: null })
  } finally {
    await db.exec('rollback; reset role')
  }
})

it('does not recreate inventory tables retired by source migrations', async () => {
  for (const table of ['inventory_product_settings', 'inventory_product_format_consumptions']) {
    expect(exportSourceTables().has(table)).toBe(false)
    expect((await db.query('select to_regclass($1) rel', [`public.${table}`])).rows[0].rel).toBeNull()
    expect((await call()).collections.map((item: { name: string }) => item.name)).not.toContain(table)
  }
  await expect(call('inventory_items')).resolves.toHaveProperty('rows')
  await expect(call('inventory_recipes')).resolves.toHaveProperty('rows')
})

it('adapts retired tables, renamed or removed fields and changed types without exposing new fields', async () => {
  await db.exec(`reset role; begin;
    drop table device_user_assignments;
    alter table products drop column description;
    alter table products rename column name to renamed_name;
    alter table products alter column sort_order type bigint;
    update products set sort_order=9007199254740993 where id='${id(46)}'`)
  try {
    await as(owner)
    const manifest = await call()
    expect(manifest.schemaChanges).toEqual(expect.arrayContaining([
      { collection: 'device_user_assignments', reason: 'table_unavailable' },
      { collection: 'products', reason: 'columns_unavailable', columns: ['name', 'description'] },
    ]))
    expect(manifest.collections.find((item: { name: string }) => item.name === 'products').columns).toContainEqual({ name: 'sort_order', type: 'bigint', encoding: 'decimal-string' })
    const page = await call('products')
    expect(page.rows[0].sort_order).toBe('9007199254740993')
    expect(page.rows[0]).not.toHaveProperty('description')
    expect(page.rows[0]).not.toHaveProperty('name')
    expect(page.rows[0]).not.toHaveProperty('renamed_name')
    expect(page.rows[0]).not.toHaveProperty('future_secret')
    expect(page.schemaToken).toBe(manifest.collections.find((item: { name: string }) => item.name === 'products').schemaToken)
    await expect(call('device_user_assignments')).rejects.toThrow(/EXPORT_SCHEMA_CHANGED/)
  } finally {
    await db.exec('rollback; reset role')
  }
})

it('uses current primary keys and marks schema changes between manifest and pages', async () => {
  const before = (await call()).collections.find((item: { name: string }) => item.name === 'products')
  await db.exec('reset role; begin; alter table products drop constraint products_pkey; alter table products add primary key(id,name)')
  try {
    await as(owner)
    const page = await call('products')
    expect(page.schemaToken).not.toBe(before.schemaToken)
    expect(page.next).toEqual([id(46), 'Producto'])
    expect((await call('products', page.next)).rows).toEqual([])
    await expect(call('products', [id(46)])).rejects.toThrow(/EXPORT_INVALID_CURSOR/)
  } finally {
    await db.exec('rollback; reset role')
  }
})

it.each([
  'alter table products drop column tenant_id',
  'alter table products drop constraint products_pkey',
  'alter table products drop constraint products_pkey; alter table products add primary key(future_secret)',
  'alter table product_images drop column storage_path',
])('refuses unsafe export when scope, stable pagination or original file ownership is unavailable: %s', async (change) => {
  await db.exec(`reset role; begin; ${change}`)
  try {
    await as(owner)
    await db.exec('savepoint before_failed_export')
    await expect(call()).rejects.toThrow(/EXPORT_SCHEMA_UNAVAILABLE/)
    await db.exec('rollback to savepoint before_failed_export')
    await expect(call(change.includes('product_images') ? 'product_images' : 'products')).rejects.toThrow(/EXPORT_SCHEMA_UNAVAILABLE/)
  } finally {
    await db.exec('rollback; reset role')
  }
})

it('excludes INCLUDE columns from primary-key pagination', async () => {
  await db.exec('reset role; begin; alter table products drop constraint products_pkey; alter table products add primary key(id) include(name)')
  try {
    await as(owner)
    const page = await call('products')
    expect(page.next).toEqual([id(46)])
    expect((await call('products', page.next)).rows).toEqual([])
  } finally {
    await db.exec('rollback; reset role')
  }
})

it('retains owner file access when suspended, rejects forged paths and stops after ownership revocation', async () => {
  const files = await db.query('select name from storage.objects')
  expect(files.rows).toEqual([{ name: `${tenant}/photo.webp` }])
  await as(stranger)
  expect((await db.query('select name from storage.objects')).rows).toEqual(expect.arrayContaining([{ name: `${other}/photo.webp` }]))
  expect((await db.query('select name from storage.objects')).rows).not.toContainEqual({ name: `${tenant}/photo.webp` })
  await db.exec('reset role')
  await db.exec(`update tenant_memberships set is_active=false where user_id='${owner}'`)
  await as(owner)
  await expect(call('tickets')).rejects.toThrow(/EXPORT_FORBIDDEN/)
  expect((await db.query('select name from storage.objects')).rows).toEqual([])
})
