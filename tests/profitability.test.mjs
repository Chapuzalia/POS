import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../supabase/migrations/20260916170000_add_theoretical_profitability.sql', import.meta.url), 'utf8')
const alignedMigration = await readFile(new URL('../supabase/migrations/20260918120000_align_theoretical_cost_with_inventory_consumption.sql', import.meta.url), 'utf8')

const compact = (value) => value.replace(/--.*$/gm, '').replace(/\s+/g, ' ')
const sql = compact(alignedMigration)
const theoreticalLineCost = alignedMigration.slice(
  alignedMigration.indexOf('create function public.theoretical_ticket_line_cost('),
  alignedMigration.indexOf('\n\ncreate or replace function public.set_ticket_line_theoretical_cost()'),
)
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('la rentabilidad conserva snapshots y no rellena históricos', () => {
  assert.match(migration, /add column if not exists theoretical_cost_cents integer/i)
  assert.match(migration, /theoretical_cost_known boolean default false/i)
  assert.doesNotMatch(migration, /theoretical_cost_known boolean not null default false/i)
  assert.match(migration, /new\.theoretical_cost_cents\s*:=\s*case\s+when\s+new\.theoretical_cost_known/i)
  assert.match(migration, /theoretical_cost_cents is null/i)
})

test('el coste de compras usa las últimas tres compras confirmadas con precio', () => {
  assert.match(migration, /order by\s+coalesce\(\s*document\.confirmed_at,\s*document\.document_date::timestamptz,\s*document\.created_at\s*\)\s+desc/i)
  assert.match(migration, /limit 3/i)
  assert.match(migration, /select avg\(costs\.normalized_unit_cost\)/i)
})

test('los porcentajes de rentabilidad salen de totales y hay cobertura', () => {
  assert.match(migration, /known_net_sales_cents/i)
  assert.match(migration, /known_gross_sales_cents/i)
  assert.match(migration, /when\s+theoretical_cost_known\s+then\s+theoretical_cost_cents\s+else\s+0\s+end/i)
})

test('el coste por línea usa el mismo acumulador de inventario que el consumo', () => {
  assert.match(sql, /create (?:or replace )?function public\.theoretical_ticket_line_cost\s*\(\s*p_ticket_line_id uuid\s*\)\s*returns jsonb/i)
  assert.match(sql, /inventory_accumulate_variant_recipe\s*\(/i)
  assert.match(sql, /new\.variant_id|line\.variant_id|ticket_line\.variant_id/i)
  assert.match(sql, /coalesce\(\s*new\.allocated_quantity\s*,\s*new\.quantity|coalesce\(\s*line\.allocated_quantity\s*,\s*line\.quantity/i)
  assert.match(sql, /'product'|product_id/i)
})

test('la resolución cubre mixers explícitos, fallback legacy y componentes de menú', () => {
  assert.match(sql, /ticket_line_components/i)
  assert.match(sql, /component_type\s*=\s*'mixer'|component_type.*mixer/i)
  assert.match(sql, /'mixer'/i)
  assert.match(sql, /component_type.*menu_component|menu_component.*component_type/i)
  assert.match(sql, /mixer:[^']*uuid|mixer:\[0-9a-f|mixer_product_id/i)
  assert.match(sql, /not exists\s*\([^)]*ticket_line_components|fallback|legacy/i)
})

test('los multiplicadores distinguen cantidad vendida y cantidad del componente', () => {
  assert.match(sql, /allocated_quantity|sold_quantity|line_quantity/i)
  assert.match(sql, /v_sold_quantity\s*\*\s*v_component\.quantity/i)
  assert.match(sql, /v_modifier_row\.quantity\s*\*\s*v_modifier_row\.multiplier/i)
})

test('los modifiers de línea y de componente aplican REMOVE antes que ADD', () => {
  assert.match(sql, /new\.modifiers|line\.modifiers/i)
  assert.match(sql, /metadata[^;]{0,300}modifiers|component[^;]{0,300}modifiers/i)
  assert.match(sql, /modifier_inventory_effects/i)
  assert.match(sql, /operation\s*=\s*'REMOVE'/i)
  assert.match(sql, /operation\s*=\s*'ADD'/i)
  assert.match(sql, /delete from|remove|subtract/i)

  const removePosition = sql.search(/effect\.operation\s*=\s*'REMOVE'/i)
  const addPosition = sql.search(/effect\.operation\s*=\s*'ADD'/i)
  assert.notEqual(removePosition, -1)
  assert.notEqual(addPosition, -1)
  assert.ok(removePosition < addPosition, 'REMOVE debe resolverse antes que ADD')
})

test('el trigger calcula el snapshot después de capturar componentes y solo en INSERT', () => {
  assert.match(sql, /create trigger/i)
  assert.match(sql, /after\s+insert/i)
  assert.doesNotMatch(sql, /after\s+insert\s+or\s+update/i)
  assert.match(sql, /theoretical_ticket_line_cost/i)

  const costTriggerPosition = sql.search(/create trigger[^;]*theoretical[^;]*after\s+insert/i)
  assert.notEqual(costTriggerPosition, -1, 'la migración debe declarar el trigger de snapshot')
  assert.match(
    alignedMigration,
    /same-kind triggers by name[\s\S]*after capture_ticket_line_components[\s\S]*create trigger zz_set_ticket_line_theoretical_cost_after_components/i,
  )
})

test('las actualizaciones posteriores conservan el snapshot histórico', () => {
  assert.match(
    sql,
    /if tg_op = 'UPDATE'.*pg_trigger_depth\(\) > 1.*new\.theoretical_cost_known := old\.theoretical_cost_known.*new\.theoretical_cost_cents := old\.theoretical_cost_cents/s,
  )
})

test('el cálculo persiste coste en céntimos y conserva unknown cuando no hay costes conocidos', () => {
  assert.match(sql, /theoretical_cost_cents/i)
  assert.match(sql, /theoretical_cost_known/i)
  assert.match(sql, /known/i)
  assert.match(sql, /cost[^;]{0,400}(\*\s*100|100\s*\*)|round\s*\([^;]{0,400}100/i)
  assert.match(sql, /jsonb_build_object|->>\s*'cost'/i)
})

test('theoretical_ticket_line_cost resuelve una línea completa con recetas, componentes y modifiers', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const tenant = id(1), venue = id(2), ticket = id(3), line = id(4)
  const product = id(10), productVariant = id(11), mixer = id(12), mixerVariant = id(13)
  const menu = id(14), menuVariant = id(15)
  const itemBase = id(20), itemMixer = id(21), itemMenu = id(22), itemModifier = id(23), itemAdd = id(24)
  const componentModifier = id(30), removeModifier = id(31), addModifier = id(32)

  await db.exec(`
    create table public.tickets (id uuid primary key, tenant_id uuid not null, venue_id uuid not null);
    create table public.ticket_lines (
      id uuid primary key, ticket_id uuid not null, tenant_id uuid not null, variant_id uuid not null,
      product_id uuid not null, allocated_quantity numeric, quantity numeric not null, modifiers jsonb,
      theoretical_cost_cents integer, theoretical_cost_known boolean
    );
    create table public.ticket_line_components (
      id uuid primary key, ticket_line_id uuid not null, tenant_id uuid not null,
      component_type text not null, product_id uuid not null, variant_id uuid, quantity numeric not null,
      metadata jsonb, sort_order integer not null
    );
    create table public.product_variants (
      id uuid primary key, product_id uuid not null, tenant_id uuid not null, venue_id uuid not null,
      is_active boolean not null, is_default boolean not null, sort_order integer not null
    );
    create table public.inventory_items (id uuid primary key, tenant_id uuid not null, venue_id uuid not null, base_unit_id uuid not null);
    create table public.recipe_fixture (variant_id uuid not null, inventory_item_id uuid not null, quantity numeric not null);
    create table public.inventory_cost_fixture (inventory_item_id uuid primary key, unit_cost numeric not null, known boolean not null);
    create table public.modifier_inventory_effects (
      id uuid primary key, modifier_id uuid not null, tenant_id uuid not null, venue_id uuid not null,
      operation text not null, inventory_item_id uuid not null, quantity numeric not null, unit_id uuid not null, sort_order integer not null
    );
    create function public.inventory_convert_quantity(t uuid, v uuid, quantity numeric, unit_id uuid, base_unit_id uuid)
      returns numeric language sql immutable as $$ select quantity $$;
    create function public.inventory_accumulate_variant_recipe(
      t uuid, v uuid, variant uuid, multiplier numeric, source_type text, source_id uuid
    ) returns void language plpgsql as $$
    begin
      insert into pg_temp.inventory_resolved_line(inventory_item_id, stock_quantity, sources)
      select recipe.inventory_item_id, recipe.quantity * multiplier,
        jsonb_build_array(jsonb_build_object('type', source_type, 'sourceId', source_id))
      from public.recipe_fixture recipe where recipe.variant_id = variant
      on conflict (inventory_item_id) do update set stock_quantity = pg_temp.inventory_resolved_line.stock_quantity + excluded.stock_quantity;
    end $$;
    create function public.theoretical_inventory_item_cost(t uuid, v uuid, item uuid, quantity numeric, unit uuid)
      returns jsonb language sql stable as $$
      select jsonb_build_object('known', fixture.known, 'cost', quantity * fixture.unit_cost)
      from public.inventory_cost_fixture fixture where fixture.inventory_item_id = item
    $$;
  `)
  await db.exec(theoreticalLineCost)
  await db.exec(`
    insert into public.tickets values ('${ticket}', '${tenant}', '${venue}');
    insert into public.ticket_lines values ('${line}', '${ticket}', '${tenant}', '${productVariant}', '${product}', 3, 2, jsonb_build_array(
      jsonb_build_object('id', '${removeModifier}'), jsonb_build_object('id', '${addModifier}')
    ), null, null);
    insert into public.product_variants values
      ('${productVariant}', '${product}', '${tenant}', '${venue}', true, true, 1),
      ('${mixerVariant}', '${mixer}', '${tenant}', '${venue}', true, true, 1),
      ('${menuVariant}', '${menu}', '${tenant}', '${venue}', true, true, 1);
    insert into public.ticket_line_components values
      ('${id(40)}', '${line}', '${tenant}', 'mixer', '${mixer}', '${mixerVariant}', 0.75, '{}', 1),
      ('${id(41)}', '${line}', '${tenant}', 'menu_component', '${menu}', '${menuVariant}', 2, jsonb_build_object('modifiers', jsonb_build_array(jsonb_build_object('id', '${componentModifier}'))), 2);
    insert into public.inventory_items values
      ('${itemBase}', '${tenant}', '${venue}', '${id(90)}'), ('${itemMixer}', '${tenant}', '${venue}', '${id(90)}'),
      ('${itemMenu}', '${tenant}', '${venue}', '${id(90)}'), ('${itemModifier}', '${tenant}', '${venue}', '${id(90)}'), ('${itemAdd}', '${tenant}', '${venue}', '${id(90)}');
    insert into public.recipe_fixture values
      ('${productVariant}', '${itemBase}', 2), ('${mixerVariant}', '${itemMixer}', 0.75), ('${menuVariant}', '${itemMenu}', 0.4);
    insert into public.inventory_cost_fixture values
      ('${itemBase}', 1.25, true), ('${itemMixer}', 2, true), ('${itemMenu}', 3, true), ('${itemModifier}', 4, true), ('${itemAdd}', 5, true);
    insert into public.modifier_inventory_effects values
      ('${id(50)}', '${componentModifier}', '${tenant}', '${venue}', 'ADD', '${itemModifier}', 0.2, '${id(90)}', 1),
      ('${id(51)}', '${removeModifier}', '${tenant}', '${venue}', 'REMOVE', '${itemBase}', 99, '${id(90)}', 1),
      ('${id(52)}', '${addModifier}', '${tenant}', '${venue}', 'ADD', '${itemBase}', 0.5, '${id(90)}', 2),
      ('${id(53)}', '${addModifier}', '${tenant}', '${venue}', 'ADD', '${itemAdd}', 0.3, '${id(90)}', 3);
  `)
  const [result] = (await db.query('select public.theoretical_ticket_line_cost($1) as cost', [line])).rows
  assert.equal(result.cost.known, true)
  assert.equal(result.cost.cost, 21.75)

  const legacyLine = id(5)
  const legacyMixerProduct = id(60), legacyMixerVariant = id(61), legacyItem = id(62)
  await db.exec(`
    insert into public.ticket_lines values ('${legacyLine}', '${ticket}', '${tenant}', '${productVariant}', '${product}', 2.5, 1, jsonb_build_array(jsonb_build_object('id', 'mixer:${legacyMixerProduct}')), null, null);
    insert into public.product_variants values ('${legacyMixerVariant}', '${legacyMixerProduct}', '${tenant}', '${venue}', true, true, 1);
    insert into public.inventory_items values ('${legacyItem}', '${tenant}', '${venue}', '${id(90)}');
    insert into public.recipe_fixture values ('${legacyMixerVariant}', '${legacyItem}', 0.8);
    insert into public.inventory_cost_fixture values ('${legacyItem}', 7, true);
  `)
  const [legacy] = (await db.query('select public.theoretical_ticket_line_cost($1) as cost', [legacyLine])).rows
  assert.equal(legacy.cost.known, true)
  assert.equal(legacy.cost.cost, 20.25)
})
