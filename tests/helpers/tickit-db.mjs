import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const ids = {
  tenant: uuid(1),
  venue: uuid(2),
  user: uuid(3),
  table: uuid(4),
  order: uuid(5),
  group: uuid(6),
  cash: uuid(7),
  product: uuid(8),
  variant: uuid(9),
  category: uuid(10),
  tab: uuid(11),
  placement: uuid(12),
  modifierGroup: uuid(13),
  modifier: uuid(14),
  assignment: uuid(15),
}
const baseline = readFileSync(
  new URL('../../supabase/0.Complete_Database_24-07-26.sql', import.meta.url),
  'utf8',
)
const fn = (name) => {
  const start = baseline.indexOf(`CREATE FUNCTION public.${name}(`)
  if (start < 0) throw new Error(name)
  return baseline.slice(start, baseline.indexOf('$$;', baseline.indexOf('AS $$', start)) + 3)
}
export async function createTickitDatabase(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create function extensions.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')) $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
    create function user_is_tenant_admin(uuid) returns boolean language sql stable as $$ select auth.uid()='${ids.user}'::uuid and $1='${ids.tenant}'::uuid $$;
    create function user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$ select public.user_is_tenant_admin($1) and $2='${ids.venue}'::uuid $$;
    create function resolve_effective_tax_rate(uuid,uuid,uuid) returns numeric language sql as $$ select 10::numeric $$;
    create table tenants(id uuid primary key); create table venues(id uuid primary key,tenant_id uuid);
    create table tenant_memberships(tenant_id uuid,user_id uuid,role text,is_active boolean);
    create table cash_sessions(id uuid primary key,status text);
    create table dining_areas(id uuid,tenant_id uuid,venue_id uuid,name text,sort_order integer,is_active boolean);
    create table restaurant_order_equal_splits(order_group_id uuid,status text);
  `)
  const tables = [
    'products',
    'product_variants',
    'categories',
    'catalog_tabs',
    'catalog_placements',
    'catalog_tab_categories',
    'catalog_sale_formats',
    'product_images',
    'modifier_groups',
    'modifiers',
    'product_modifier_group_assignments',
    'product_modifier_group_assignment_variants',
    'selection_groups',
    'selection_group_options',
    'product_selection_group_assignments',
    'product_selection_group_assignment_variants',
    'orders',
    'order_lines',
    'order_tables',
    'order_line_components',
    'restaurant_tables',
  ]
  for (const name of tables) {
    const match = baseline.match(new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]*?\\n\\);`))
    if (!match) throw new Error(`Missing fixture table ${name}`)
    await db.exec(match[0])
  }
  await db.exec(`alter table products add primary key(id); alter table orders add primary key(id);
    alter table restaurant_tables add primary key(id); alter table restaurant_tables add column cash_session_id uuid;
    alter table order_lines alter column quantity type numeric(18,3); alter table order_lines alter column served_quantity type numeric(18,3);`)
  await db.exec(fn('canonical_catalog_modifiers'))
  await db.exec(fn('get_catalog_without_formats'))
  // Same aggregate contract, with real catalog queries and formats; production routing is unrelated to appending.
  await db.exec(`create function public.get_catalog(uuid,text) returns jsonb language sql as $$
    select public.get_catalog_without_formats($1,$2) || jsonb_build_object('sale_formats',coalesce((select jsonb_agg(to_jsonb(f)) from public.catalog_sale_formats f where venue_id=$1),'[]'::jsonb),'variant_formats','[]'::jsonb)
  $$;`)
  await db.exec(
    readFileSync(
      new URL('../../supabase/migrations/20261017234914_tickit_carta_api.sql', import.meta.url),
      'utf8',
    ),
  )
  const x = ids
  await db.exec(
    readFileSync(
      new URL(
        '../../supabase/migrations/20261018001409_tickit_carta_table_links_api.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  await db.exec(`insert into tenants values('${x.tenant}'); insert into venues values('${x.venue}','${x.tenant}');
    insert into tenant_memberships values('${x.tenant}','${x.user}','owner',true);
    select set_config('test.uid','${x.user}',false);
    insert into cash_sessions values('${x.cash}','open');
    insert into restaurant_tables(id,tenant_id,venue_id,area_id,name) values('${x.table}','${x.tenant}','${x.venue}','${uuid(90)}','Mesa 1');
    insert into orders(id,tenant_id,venue_id,cash_session_id,cash_register_id,opened_by_user_id,order_group_id) values('${x.order}','${x.tenant}','${x.venue}','${x.cash}','${uuid(91)}','${x.user}','${x.group}');
    insert into order_tables(tenant_id,venue_id,order_id,order_group_id,table_id) values('${x.tenant}','${x.venue}','${x.order}','${x.group}','${x.table}');
    insert into products(id,tenant_id,venue_id,name) values('${x.product}','${x.tenant}','${x.venue}','Plato');
    insert into product_variants(id,tenant_id,venue_id,product_id,name,price_cents,is_default) values('${x.variant}','${x.tenant}','${x.venue}','${x.product}','Normal',1234,true);
    insert into categories(id,tenant_id,venue_id,name) values('${x.category}','${x.tenant}','${x.venue}','Platos');
    insert into catalog_tabs(id,tenant_id,venue_id,key,label) values('${x.tab}','${x.tenant}','${x.venue}','carta','Carta');
    insert into catalog_placements(id,tenant_id,venue_id,tab_id,category_id,product_id) values('${x.placement}','${x.tenant}','${x.venue}','${x.tab}','${x.category}','${x.product}');
    insert into modifier_groups(id,tenant_id,venue_id,name) values('${x.modifierGroup}','${x.tenant}','${x.venue}','Extras');
    insert into modifiers(id,tenant_id,venue_id,group_id,name,supplement_cents) values('${x.modifier}','${x.tenant}','${x.venue}','${x.modifierGroup}','Queso',29);
    insert into product_modifier_group_assignments(id,tenant_id,venue_id,product_id,group_id,min_selection,max_selection) values('${x.assignment}','${x.tenant}','${x.venue}','${x.product}','${x.modifierGroup}',0,1);
  `)
  const configure = (await db.query('select tickit_carta_configure($1,true) result', [x.venue]))
    .rows[0].result
  return { db, configure }
}
