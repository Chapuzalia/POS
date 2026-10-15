import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const migration = readFileSync(new URL('../supabase/migrations/20261015120000_optimize_crm_stats_period.sql', import.meta.url), 'utf8')
const previous = readFileSync(new URL('../supabase/migrations/20261014115222_equal_split_single_ticket.sql', import.meta.url), 'utf8')
const original = previous.slice(previous.indexOf('create or replace function public.crm_stats_period('), previous.indexOf('create or replace function public.crm_stats_live('))
const baseline = original.replace('public.crm_stats_period(', 'public.crm_stats_period_baseline(')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), venue = id(2)
const from = '2026-10-01T04:00:00Z', to = '2026-11-01T05:00:00Z'
const signature = 'crm_stats_period(uuid,uuid,text,date,date,date,timestamptz,timestamptz,text,time)'
const args = [tenant, venue, 'month', '2026-10-01', '2026-10-31', '2026-10-31', from, to, 'Europe/Madrid', '06:00']

async function fixture(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role authenticated; create role anon; create role service_role;
    create table tickets(id uuid primary key, tenant_id uuid, venue_id uuid, status text, local_created_at timestamptz, total_cents integer, discount_amount_cents integer, discount_id uuid, discount_name text);
    create table ticket_lines(id uuid primary key, tenant_id uuid, ticket_id uuid, product_id uuid, product_name text, category_id_snapshot uuid, category_name_snapshot text, quantity integer, allocated_quantity numeric, line_total_cents integer, modifiers jsonb);
    create table ticket_line_components(id uuid primary key, tenant_id uuid, ticket_line_id uuid, component_type text, product_name_snapshot text, sort_order integer, metadata jsonb);
    create table sales(id uuid primary key, tenant_id uuid, venue_id uuid, local_created_at timestamptz, payment_method text, total_cents integer);
    create table sale_payments(id uuid primary key, tenant_id uuid, sale_id uuid, method text not null, amount_cents integer);
    create table cash_sessions(id uuid primary key, tenant_id uuid, venue_id uuid, opened_at timestamptz);
    create index tickets_venue_local_created_idx on tickets(tenant_id, venue_id, local_created_at);
    create index sales_venue_local_created_idx on sales(tenant_id, venue_id, local_created_at);
    create index ticket_lines_ticket_id_id_idx on ticket_lines(ticket_id, id);
    create index ticket_line_components_line_idx on ticket_line_components(ticket_line_id);
    ${original}
    ${baseline}
    revoke all on function public.${signature} from public, anon;
    grant execute on function public.${signature} to authenticated, service_role;
    ${migration}
  `)
  return db
}

async function stats(db, options = {}, name = 'crm_stats_period') {
  const values = [...args]
  if (options.tenant) values[0] = options.tenant
  if (options.venue) values[1] = options.venue
  if (options.from) values[6] = options.from
  if (options.to) values[7] = options.to
  return (await db.query(`select public.${name}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result`, values)).rows[0].result
}

// Equal ranking can produce a different order for equivalent aggregates.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonical(item)]))
  return value
}

async function seed(db) {
  for (const [n, scopeTenant, scopeVenue, date, status, total, discount] of [
    [10, tenant, venue, from, 'paid', 1001, 99],
    [11, tenant, venue, '2026-10-02T00:30:00Z', 'paid', 503, 0],
    [12, tenant, venue, '2026-10-25T01:30:00Z', 'paid', 307, 0],
    [13, tenant, venue, '2026-10-03T10:00:00Z', 'paid', 211, 0],
    [14, tenant, venue, '2026-10-04T10:00:00Z', 'paid', 0, 0],
    [15, tenant, venue, '2026-10-05T10:00:00Z', 'void', 900, 0],
    [16, tenant, venue, to, 'paid', 900, 0],
    [17, id(3), venue, from, 'paid', 900, 0],
    [18, tenant, id(4), from, 'paid', 900, 0],
    [19, tenant, venue, '2026-10-01T03:59:59Z', 'paid', 900, 0],
  ]) {
    await db.query('insert into tickets values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id(n), scopeTenant, scopeVenue, status, date, total, discount, null, discount ? 'Manual' : null])
    await db.query('insert into ticket_lines values($1,$2,$3,null,$4,null,$5,2,$6,$7,$8)', [id(100 + n), scopeTenant, id(n), n === 10 ? 'Café' : 'Agua', n === 10 ? 'Bebidas' : null, n === 12 ? '0.75' : null, total,
      n === 10 ? JSON.stringify([{ name: ' Hielo ' }, { name: 'Hielo' }, { name: 'Ignore', groupId: 'mixer' }, { name: 'Ignore', id: 'mixer:1' }, { name: ' ' }]) : null])
    if (status === 'paid') await db.query('insert into sales values($1,$2,$3,$4,$5,$6)', [id(200 + n), scopeTenant, scopeVenue, date, n === 14 ? 'invitation' : 'cash', total])
  }
  await db.exec(`
    insert into sale_payments values
      ('${id(301)}','${tenant}','${id(210)}','card',601),
      ('${id(302)}','${tenant}','${id(210)}','cash',200),
      ('${id(303)}','${tenant}','${id(210)}','cash',200),
      ('${id(304)}','${tenant}','${id(213)}','invitation',211),
      ('${id(305)}','${id(3)}','${id(211)}','card',9999);
    insert into ticket_line_components values
      ('${id(401)}','${tenant}','${id(110)}','mixer',' Tónica ',1,'{"modifiers":[{"name":"ignored"}]}'),
      ('${id(402)}','${tenant}','${id(110)}','mixer','Tónica',2,'{}'),
      ('${id(403)}','${tenant}','${id(110)}','mixer','Agua',3,'{}'),
      ('${id(404)}','${tenant}','${id(110)}','base','Not a mixer',0,'{}'),
      ('${id(405)}','${id(3)}','${id(110)}','mixer','Other tenant',0,'{}');
    insert into cash_sessions values
      ('${id(501)}','${tenant}','${venue}','2026-10-06T10:00:00Z'),
      ('${id(502)}','${tenant}','${venue}','${to}'),
      ('${id(503)}','${id(3)}','${venue}','2026-10-07T10:00:00Z'),
      ('${id(504)}','${tenant}','${id(4)}','2026-10-08T10:00:00Z');
  `)
}

test('stats optimization passes the production migration guard', () => {
  assert.deepEqual(analyzeMigration(migration), [])
})

test('period aggregates retain the previous JSON, mixed/legacy tenders, snapshots and operational dates', async t => {
  const db = await fixture(t)
  await seed(db)
  for (const options of [{}, { tenant: id(3) }, { venue: id(4) }, { tenant: id(99) }, { from: to, to: '2026-11-02T05:00:00Z' }]) {
    assert.deepEqual(canonical(await stats(db, options)), canonical(await stats(db, options, 'crm_stats_period_baseline')))
  }
  const actual = await stats(db)
  assert.equal(actual.monthSalesCents, 2022)
  assert.equal(actual.monthTicketCount, 5)
  assert.equal(actual.discountsCents, 99)
  assert.equal(actual.discountApplications[0].ticketPercentage, 20)
  assert.deepEqual(actual.byPayment, [{ method: 'cash', totalCents: 1210, count: 3 }, { method: 'card', totalCents: 601, count: 1 }])
  assert.deepEqual(actual.topProductCombinations.find(row => row.productName === 'Café'), { productName: 'Café', mixers: ['Agua', 'Tónica'], modifiers: ['Hielo'], quantity: 2, totalCents: 1001 })
  assert.equal(actual.salesByProduct.find(row => row.label === 'Agua').quantity, 6.75)
  assert.equal(actual.period.openDayCount, 5)
  assert.equal(actual.hourlySales.length, 24)
})

test('replacement preserves invoker RLS, venue isolation and existing execute permissions', async t => {
  const db = await fixture(t)
  await seed(db)
  for (const table of ['tickets', 'sales', 'cash_sessions']) {
    await db.exec(`alter table ${table} enable row level security;
      create policy scope on ${table} to authenticated using (tenant_id = current_setting('app.tenant')::uuid and venue_id = current_setting('app.venue')::uuid);`)
  }
  await db.exec(`
    alter table ticket_lines enable row level security;
    alter table ticket_line_components enable row level security;
    alter table sale_payments enable row level security;
    create policy scope on ticket_lines to authenticated using (exists(select 1 from tickets t where t.id = ticket_id));
    create policy scope on ticket_line_components to authenticated using (exists(select 1 from ticket_lines tl where tl.id = ticket_line_id));
    create policy scope on sale_payments to authenticated using (exists(select 1 from sales s where s.id = sale_id));
    grant select on all tables in schema public to authenticated;
    set app.tenant = '${tenant}'; set app.venue = '${venue}'; set role authenticated;
  `)
  assert.equal((await stats(db)).monthSalesCents, 2022)
  for (const options of [{ tenant: id(3) }, { venue: id(4) }]) {
    const result = await stats(db, options)
    assert.equal(result.monthTicketCount, 0)
    assert.deepEqual(result.byPayment, [])
    assert.deepEqual(result.salesByProduct, [])
    assert.equal(result.period.openDayCount, 0)
  }
  await db.exec('reset role')
  const permissions = (await db.query(`select prosecdef,
    has_function_privilege('authenticated', 'public.${signature}', 'execute') authenticated,
    has_function_privilege('service_role', 'public.${signature}', 'execute') service_role,
    has_function_privilege('anon', 'public.${signature}', 'execute') anon
    from pg_proc where oid = 'public.${signature}'::regprocedure`)).rows[0]
  assert.deepEqual(permissions, { prosecdef: false, authenticated: true, service_role: true, anon: false })
})

test('combination ranking merges different historical component snapshots before taking the top eight', async t => {
  const db = await fixture(t)
  await db.exec(`
    insert into tickets values('${id(10)}','${tenant}','${venue}','paid','${from}',5500,0,null,null);
    insert into ticket_lines
      select md5('rank-line' || n)::uuid,'${tenant}','${id(10)}',null,'Producto ' || n,null,null,n,null,n * 100,
        jsonb_build_array(jsonb_build_object('name','Hielo','id',n))
      from generate_series(1,10) n;
    insert into ticket_lines values('${id(20)}','${tenant}','${id(10)}',null,'Producto 1',null,null,20,null,0,'[{"name":" Hielo "}]');
    insert into ticket_line_components
      select md5('rank-component' || n)::uuid,'${tenant}',md5('rank-line' || n)::uuid,'mixer','Tónica',1,jsonb_build_object('historical',n)
      from generate_series(1,10) n;
    insert into ticket_line_components values('${id(21)}','${tenant}','${id(20)}','mixer',' Tónica ',10,'{"historical":"different"}');
  `)
  const actual = await stats(db)
  assert.deepEqual(canonical(actual), canonical(await stats(db, {}, 'crm_stats_period_baseline')))
  assert.equal(actual.topProductCombinations.length, 8)
  assert.deepEqual(actual.topProductCombinations[0], { productName: 'Producto 1', mixers: ['Tónica'], modifiers: ['Hielo'], quantity: 21, totalCents: 100 })
  assert.deepEqual(actual.topProducts.map(row => row.productName), ['Producto 1', 'Producto 10', 'Producto 9', 'Producto 8', 'Producto 7', 'Producto 6', 'Producto 5', 'Producto 4'])
})

function planNodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)]
}

test('large periods use set joins and retain exact totals above the integer range', async t => {
  const db = await fixture(t)
  const count = 12000
  await db.exec(`
    insert into tickets select md5('ticket' || n)::uuid,'${tenant}','${venue}','paid','2026-10-02T12:00:00Z',250001,0,null,null from generate_series(1,${count}) n;
    insert into ticket_lines select md5('line' || n)::uuid,'${tenant}',md5('ticket' || n)::uuid,null,'Combinado',null,'Bebidas',1,null,250001,'[{"name":"Hielo"}]' from generate_series(1,${count}) n;
    insert into ticket_line_components select md5('mixer' || n)::uuid,'${tenant}',md5('line' || n)::uuid,'mixer','Tónica',1,'{}' from generate_series(1,${count}) n;
    insert into ticket_line_components select md5('base' || n)::uuid,'${tenant}',md5('line' || n)::uuid,'base','Base',0,jsonb_build_object('unused',repeat('x',1024)) from generate_series(1,${count}) n;
    insert into sales select md5('sale' || n)::uuid,'${tenant}','${venue}','2026-10-02T12:00:00Z',null,250001 from generate_series(1,${count}) n;
    insert into sale_payments select md5('cash' || n)::uuid,'${tenant}',md5('sale' || n)::uuid,'cash',100000 from generate_series(1,${count}) n;
    insert into sale_payments select md5('card' || n)::uuid,'${tenant}',md5('sale' || n)::uuid,'card',150001 from generate_series(1,${count}) n;
    analyze;
  `)
  const started = performance.now()
  const actual = await stats(db)
  t.diagnostic(`${count} sales, ${count * 2} tenders and ${count * 2} components: ${(performance.now() - started).toFixed(0)} ms in PGlite`)
  assert.equal(actual.monthTicketCount, count)
  assert.equal(actual.monthSalesCents, 3000012000)
  assert.equal(actual.averageTicketCents, 250001)
  assert.deepEqual(actual.byPayment, [{ method: 'card', totalCents: 1800012000, count }, { method: 'cash', totalCents: 1200000000, count }])
  assert.deepEqual(actual.topProductCombinations, [{ productName: 'Combinado', mixers: ['Tónica'], modifiers: ['Hielo'], quantity: count, totalCents: 3000012000 }])

  const body = migration.slice(migration.indexOf('as $$') + 5, migration.lastIndexOf('$$;'))
  const names = ['p_tenant_id', 'p_venue_id', 'p_period_kind', 'p_period_start_date', 'p_period_end_date', 'p_effective_end_date', 'p_period_start', 'p_period_end', 'p_time_zone', 'p_day_change_time']
  const casts = ['uuid', 'uuid', 'text', 'date', 'date', 'date', 'timestamptz', 'timestamptz', 'text', 'time']
  const literals = Object.fromEntries(names.map((name, i) => [name, `'${args[i]}'::${casts[i]}`]))
  const query = body.replace(/\bp_\w+\b/g, name => literals[name])
  const plan = (await db.query('explain (analyze, format json) ' + query)).rows[0]['QUERY PLAN'][0].Plan
  const nodes = planNodes(plan)
  // Reading many payment/component rows must not become a full table scan per sale/line.
  for (const table of ['sale_payments', 'ticket_line_components']) {
    const scans = nodes.filter(node => node['Relation Name'] === table)
    assert.ok(scans.length > 0)
    assert.ok(scans.every(node => node['Node Type'] !== 'Seq Scan' || node['Actual Loops'] <= 1), table)
  }
  // Modifier JSON is expanded per distinct snapshot, not per sold line.
  const jsonScans = nodes.filter(node => node['Function Name'] === 'jsonb_array_elements')
  assert.equal(jsonScans.length, 1)
  assert.equal(jsonScans[0]['Actual Loops'], 1)
  // The missing lookup index must also support selective/legacy live RPC calls.
  const lookup = (await db.query(`explain (format json) select method, amount_cents from sale_payments where tenant_id = '${tenant}' and sale_id = md5('sale1')::uuid`)).rows[0]['QUERY PLAN'][0].Plan
  assert.ok(planNodes(lookup).some(node => node['Index Name'] === 'sale_payments_tenant_sale_stats_idx'))
})
