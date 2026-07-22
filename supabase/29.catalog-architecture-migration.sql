begin;

-- Additive catalogue architecture. Legacy columns remain intentionally available
-- so the previous application can be restored without deleting or rewriting data.
alter table public.venues add column if not exists catalog_profile text not null default 'bar_classic';
alter table public.venues drop constraint if exists venues_catalog_profile_check;
alter table public.venues add constraint venues_catalog_profile_check
  check (catalog_profile in ('bar_classic', 'restaurant', 'custom')) not valid;
alter table public.venues validate constraint venues_catalog_profile_check;

alter table public.products add column if not exists product_type text not null default 'standard';
alter table public.products drop constraint if exists products_product_type_check;
alter table public.products add constraint products_product_type_check
  check (product_type in ('standard', 'menu')) not valid;
alter table public.products validate constraint products_product_type_check;

alter table public.product_variants add column if not exists sale_format_id uuid references public.sale_formats(id) on delete restrict;
alter table public.product_variants add column if not exists is_active boolean not null default true;
alter table public.modifier_groups add column if not exists is_active boolean not null default true;
alter table public.modifiers add column if not exists is_default boolean not null default false;
alter table public.modifiers add column if not exists is_active boolean not null default true;

create table if not exists public.catalog_tabs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]+$' and key not in ('all', 'top')),
  label text not null check (char_length(trim(label)) between 1 and 80),
  icon text not null default 'receipt',
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, venue_id, key),
  unique (id, tenant_id, venue_id)
);

create table if not exists public.catalog_placements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  tab_id uuid not null references public.catalog_tabs(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete cascade,
  default_variant_id uuid references public.product_variants(id) on delete restrict,
  is_featured boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, venue_id, tab_id, category_id, product_id)
);

create table if not exists public.selection_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  kind text not null check (kind in ('mixer', 'menu_component')),
  name text not null check (char_length(trim(name)) between 1 and 100),
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint selection_groups_max_check check (max_select >= min_select),
  unique (tenant_id, venue_id, kind, name),
  unique (id, tenant_id, venue_id)
);

create table if not exists public.selection_group_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  group_id uuid not null references public.selection_groups(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete restrict,
  price_delta_cents integer not null default 0 check (price_delta_cents >= 0),
  is_default boolean not null default false,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists selection_group_items_identity_idx
  on public.selection_group_items (group_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.variant_selection_groups (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  selection_group_id uuid not null references public.selection_groups(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (variant_id, selection_group_id)
);

create table if not exists public.product_modifier_groups (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  modifier_group_id uuid not null references public.modifier_groups(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists product_modifier_groups_identity_idx
  on public.product_modifier_groups (product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid), modifier_group_id);

alter table public.ticket_lines add column if not exists sale_format_id uuid references public.sale_formats(id) on delete set null;
alter table public.ticket_lines add column if not exists sale_format_name_snapshot text;
alter table public.ticket_lines add column if not exists category_id_snapshot uuid;
alter table public.ticket_lines add column if not exists category_name_snapshot text;
alter table public.ticket_lines add column if not exists catalog_tab_id_snapshot uuid;
alter table public.ticket_lines add column if not exists catalog_tab_name_snapshot text;
alter table public.ticket_lines add column if not exists base_price_cents integer;
alter table public.ticket_lines add column if not exists component_delta_cents integer;
alter table public.ticket_lines add column if not exists modifier_delta_cents integer;
alter table public.ticket_lines add column if not exists gross_before_discount_cents integer;

create table if not exists public.ticket_line_components (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  ticket_line_id uuid not null references public.ticket_lines(id) on delete cascade,
  component_type text not null check (component_type in ('mixer', 'menu_component')),
  selection_group_id uuid references public.selection_groups(id) on delete set null,
  selection_group_name_snapshot text not null default '',
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name_snapshot text not null,
  variant_name_snapshot text not null default '',
  quantity integer not null default 1 check (quantity > 0),
  price_delta_cents integer not null default 0 check (price_delta_cents >= 0),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

alter table public.order_lines add column if not exists components jsonb not null default '[]'::jsonb;
alter table public.order_lines add column if not exists catalog_snapshot jsonb not null default '{}'::jsonb;
alter table public.order_lines drop constraint if exists order_lines_components_array;
alter table public.order_lines add constraint order_lines_components_array check (jsonb_typeof(components) = 'array') not valid;
alter table public.order_lines validate constraint order_lines_components_array;
alter table public.order_lines drop constraint if exists order_lines_catalog_snapshot_object;
alter table public.order_lines add constraint order_lines_catalog_snapshot_object check (jsonb_typeof(catalog_snapshot) = 'object') not valid;
alter table public.order_lines validate constraint order_lines_catalog_snapshot_object;

create table if not exists public.order_line_components (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  order_line_id uuid not null references public.order_lines(id) on delete cascade,
  component_type text not null check (component_type in ('mixer', 'menu_component')),
  selection_group_id uuid references public.selection_groups(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name_snapshot text not null,
  variant_name_snapshot text not null default '',
  quantity integer not null default 1 check (quantity > 0),
  price_delta_cents integer not null default 0 check (price_delta_cents >= 0),
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

-- Cross-tenant and cross-venue references are rejected centrally.
create or replace function public.validate_catalog_relation()
returns trigger language plpgsql set search_path = public as $$
declare
  product_row public.products%rowtype;
  variant_row public.product_variants%rowtype;
  group_row public.selection_groups%rowtype;
begin
  if tg_table_name = 'catalog_placements' then
    select * into product_row from public.products where id = new.product_id;
    if product_row.tenant_id <> new.tenant_id or product_row.venue_id <> new.venue_id then raise exception 'Colocacion fuera de tenant/local'; end if;
    if not exists (select 1 from public.catalog_tabs where id = new.tab_id and tenant_id = new.tenant_id and venue_id = new.venue_id) then raise exception 'Pestana fuera de tenant/local'; end if;
    if not exists (select 1 from public.categories where id = new.category_id and tenant_id = new.tenant_id) then raise exception 'Categoria fuera de tenant'; end if;
    if new.default_variant_id is not null and not exists (select 1 from public.product_variants where id = new.default_variant_id and product_id = new.product_id and is_active) then raise exception 'Variante predeterminada no valida'; end if;
  elsif tg_table_name = 'selection_group_items' then
    select * into group_row from public.selection_groups where id = new.group_id;
    select * into product_row from public.products where id = new.product_id;
    if group_row.tenant_id <> new.tenant_id or product_row.tenant_id <> new.tenant_id or product_row.venue_id <> group_row.venue_id then raise exception 'Elemento fuera de tenant/local'; end if;
    if new.variant_id is not null and not exists (select 1 from public.product_variants where id = new.variant_id and product_id = new.product_id and is_active) then raise exception 'Variante de elemento no valida'; end if;
    if group_row.kind = 'menu_component' and product_row.product_type <> 'standard' then raise exception 'Los menus solo pueden incluir productos estandar'; end if;
  elsif tg_table_name = 'variant_selection_groups' then
    select * into variant_row from public.product_variants where id = new.variant_id;
    select * into product_row from public.products where id = variant_row.product_id;
    select * into group_row from public.selection_groups where id = new.selection_group_id;
    if variant_row.tenant_id <> new.tenant_id or group_row.tenant_id <> new.tenant_id or product_row.venue_id <> group_row.venue_id then raise exception 'Asignacion fuera de tenant/local'; end if;
  elsif tg_table_name = 'product_modifier_groups' then
    if not exists (select 1 from public.products where id = new.product_id and tenant_id = new.tenant_id) then raise exception 'Producto fuera de tenant'; end if;
    if not exists (select 1 from public.modifier_groups where id = new.modifier_group_id and tenant_id = new.tenant_id) then raise exception 'Grupo fuera de tenant'; end if;
    if new.variant_id is not null and not exists (select 1 from public.product_variants where id = new.variant_id and product_id = new.product_id) then raise exception 'Variante no pertenece al producto'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_catalog_placements_relation on public.catalog_placements;
create trigger validate_catalog_placements_relation before insert or update on public.catalog_placements for each row execute function public.validate_catalog_relation();
drop trigger if exists validate_selection_group_items_relation on public.selection_group_items;
create trigger validate_selection_group_items_relation before insert or update on public.selection_group_items for each row execute function public.validate_catalog_relation();
drop trigger if exists validate_variant_selection_groups_relation on public.variant_selection_groups;
create trigger validate_variant_selection_groups_relation before insert or update on public.variant_selection_groups for each row execute function public.validate_catalog_relation();
drop trigger if exists validate_product_modifier_groups_relation on public.product_modifier_groups;
create trigger validate_product_modifier_groups_relation before insert or update on public.product_modifier_groups for each row execute function public.validate_catalog_relation();

do $$
declare table_name text;
begin
  foreach table_name in array array['catalog_tabs','catalog_placements','selection_groups','selection_group_items'] loop
    execute format('drop trigger if exists set_%I_updated_at on public.%I', table_name, table_name);
    execute format('create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()', table_name, table_name);
  end loop;
end $$;

create index if not exists catalog_tabs_venue_active_idx on public.catalog_tabs (tenant_id, venue_id, is_active, sort_order);
create index if not exists catalog_placements_tab_idx on public.catalog_placements (tenant_id, venue_id, tab_id, is_active, sort_order);
create index if not exists catalog_placements_category_idx on public.catalog_placements (tenant_id, venue_id, category_id, is_active);
create index if not exists catalog_placements_product_idx on public.catalog_placements (product_id, is_active);
create index if not exists product_variants_format_idx on public.product_variants (tenant_id, sale_format_id, is_active, sort_order);
create index if not exists selection_groups_venue_idx on public.selection_groups (tenant_id, venue_id, kind, is_active, sort_order);
create index if not exists selection_group_items_group_idx on public.selection_group_items (tenant_id, group_id, is_active, sort_order);
create index if not exists variant_selection_groups_variant_idx on public.variant_selection_groups (tenant_id, variant_id, sort_order);
create index if not exists product_modifier_groups_product_idx on public.product_modifier_groups (tenant_id, product_id, variant_id, sort_order);
create index if not exists ticket_line_components_line_idx on public.ticket_line_components (tenant_id, ticket_line_id, component_type, sort_order);
create index if not exists order_line_components_line_idx on public.order_line_components (tenant_id, venue_id, order_line_id, component_type, sort_order);

-- Normalize accidental multiple defaults before enforcing one active default.
with ranked as (
  select id, row_number() over (partition by product_id order by is_active desc, sort_order, created_at, id) as position
  from public.product_variants where is_default
)
update public.product_variants pv set is_default = false from ranked r where pv.id = r.id and r.position > 1;
create unique index if not exists product_variants_one_active_default_idx
  on public.product_variants (product_id) where is_default and is_active;

-- Alias matching exists only in this one-time backfill. Runtime code never reads names.
update public.product_variants pv
set sale_format_id = sf.id
from public.products p, public.sale_formats sf
where p.id = pv.product_id and sf.tenant_id = pv.tenant_id and pv.sale_format_id is null
  and sf.key = any(p.sale_formats)
  and case sf.key
    when 'cubata' then lower(pv.name) ~ '(cubata|copa larga|mixed)'
    when 'copa' then lower(pv.name) ~ '(^| )copa($| )|solo'
    when 'shot' then lower(pv.name) ~ '(shot|chupito)'
    when 'beer_bottle' then lower(pv.name) ~ '(cerveza|botell)'
    when 'soft_bottle' then lower(pv.name) ~ '(refresco|botell)'
    when 'cocktail' then lower(pv.name) ~ '(cocktail|coctel|cóctel)'
    else lower(pv.name) = lower(sf.label)
  end;

with variant_positions as (
  select pv.id, pv.product_id, row_number() over (partition by pv.product_id order by pv.sort_order, pv.created_at, pv.id) as position
  from public.product_variants pv where pv.sale_format_id is null
), format_positions as (
  select p.id as product_id, f.key, f.position
  from public.products p cross join lateral unnest(p.sale_formats) with ordinality f(key, position)
)
update public.product_variants pv set sale_format_id = sf.id
from variant_positions vp join format_positions fp on fp.product_id = vp.product_id and fp.position = vp.position
join public.sale_formats sf on sf.key = fp.key
where pv.id = vp.id and pv.sale_format_id is null and sf.tenant_id = pv.tenant_id;

update public.venues set catalog_profile = 'bar_classic' where catalog_profile is null or catalog_profile not in ('bar_classic','restaurant','custom');

insert into public.catalog_tabs (tenant_id, venue_id, key, label, icon, sort_order, is_active)
select v.tenant_id, v.id, sf.key, sf.label, sf.key, sf.sort_order, sf.is_active
from public.venues v join public.sale_formats sf on sf.tenant_id = v.tenant_id
where sf.key = any(array['cubata','copa','shot','beer_bottle','soft_bottle','cocktail'])
on conflict (tenant_id, venue_id, key) do update
set label = excluded.label, icon = excluded.icon, sort_order = excluded.sort_order;

insert into public.catalog_placements (tenant_id, venue_id, tab_id, category_id, product_id, default_variant_id, is_featured, sort_order, is_active)
select p.tenant_id, p.venue_id, ct.id, p.category_id, p.id,
  coalesce((select pv.id from public.product_variants pv join public.sale_formats sf on sf.id = pv.sale_format_id
    where pv.product_id = p.id and sf.key = ct.key and pv.is_active order by pv.is_default desc, pv.sort_order limit 1),
    (select pv.id from public.product_variants pv where pv.product_id = p.id and pv.is_active order by pv.is_default desc, pv.sort_order limit 1)),
  p.is_featured, p.sort_order, p.is_active
from public.products p join public.catalog_tabs ct on ct.tenant_id = p.tenant_id and ct.venue_id = p.venue_id and ct.key = any(p.sale_formats)
on conflict (tenant_id, venue_id, tab_id, category_id, product_id) do nothing;

insert into public.selection_groups (tenant_id, venue_id, kind, name, min_select, max_select, sort_order, is_active)
select v.tenant_id, v.id, 'mixer', 'Mixers estándar', 1, 1, 0, true
from public.venues v where exists (select 1 from public.products p where p.venue_id = v.id and p.can_use_as_mixer)
on conflict (tenant_id, venue_id, kind, name) do nothing;

insert into public.selection_group_items (tenant_id, group_id, product_id, variant_id, price_delta_cents, is_default, sort_order, is_active)
select p.tenant_id, sg.id, p.id, null, p.mixer_supplement_cents, false, p.sort_order, p.is_active
from public.products p join public.selection_groups sg on sg.tenant_id = p.tenant_id and sg.venue_id = p.venue_id and sg.kind = 'mixer' and sg.name = 'Mixers estándar'
where p.can_use_as_mixer
on conflict (group_id, product_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))) do nothing;

insert into public.variant_selection_groups (tenant_id, variant_id, selection_group_id, sort_order)
select pv.tenant_id, pv.id, sg.id, 0
from public.product_variants pv join public.products p on p.id = pv.product_id
join public.sale_formats sf on sf.id = pv.sale_format_id and sf.key = 'cubata'
join public.selection_groups sg on sg.tenant_id = p.tenant_id and sg.venue_id = p.venue_id and sg.kind = 'mixer' and sg.name = 'Mixers estándar'
on conflict (variant_id, selection_group_id) do nothing;

insert into public.product_modifier_groups (tenant_id, product_id, variant_id, modifier_group_id, sort_order)
select tenant_id, product_id, null, id, sort_order from public.modifier_groups
on conflict (product_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)), modifier_group_id) do nothing;

update public.order_lines ol set components = jsonb_build_array(jsonb_build_object(
  'id', coalesce(ol.mixer_product_id::text, 'legacy-mixer'), 'type', 'mixer', 'selectionGroupId', null,
  'selectionGroupName', 'Mixer', 'productId', ol.mixer_product_id, 'variantId', ol.mixer ->> 'variantId',
  'productName', coalesce(ol.mixer ->> 'name', 'Mixer'), 'variantName', '', 'quantity', 1,
  'priceDeltaCents', coalesce((ol.mixer ->> 'priceCents')::integer, 0), 'sortOrder', 0
)) where ol.mixer_product_id is not null and ol.components = '[]'::jsonb;

update public.order_lines ol set catalog_snapshot = jsonb_build_object(
  'saleFormatId', pv.sale_format_id, 'saleFormatName', coalesce(sf.label, ol.variant_name),
  'categoryId', p.category_id, 'categoryName', coalesce(c.name, ''),
  'catalogTabId', null, 'catalogTabName', ''
)
from public.products p left join public.categories c on c.id = p.category_id
left join public.product_variants pv on pv.product_id = p.id
left join public.sale_formats sf on sf.id = pv.sale_format_id
where p.id = ol.product_id and (pv.id = ol.variant_id or ol.variant_id is null) and ol.catalog_snapshot = '{}'::jsonb;

insert into public.order_line_components (tenant_id, venue_id, order_line_id, component_type, selection_group_id, product_id, variant_id, product_name_snapshot, variant_name_snapshot, quantity, price_delta_cents, sort_order)
select ol.tenant_id, ol.venue_id, ol.id, 'mixer', null, ol.mixer_product_id, null,
  coalesce(ol.mixer ->> 'name', 'Mixer'), '', 1, coalesce((ol.mixer ->> 'priceCents')::integer, 0), 0
from public.order_lines ol where ol.mixer_product_id is not null
  and not exists (select 1 from public.order_line_components c where c.order_line_id = ol.id and c.component_type = 'mixer');

-- Historical fallback: stored line names win; current category/format are only used where history had no equivalent ID.
update public.ticket_lines tl set
  sale_format_id = coalesce(tl.sale_format_id, (select pv.sale_format_id from public.product_variants pv where pv.id = tl.variant_id)),
  sale_format_name_snapshot = coalesce(tl.sale_format_name_snapshot, (select sf.label from public.product_variants pv join public.sale_formats sf on sf.id = pv.sale_format_id where pv.id = tl.variant_id), nullif(tl.variant_name, '')),
  category_id_snapshot = coalesce(tl.category_id_snapshot, (select p.category_id from public.products p where p.id = tl.product_id)),
  category_name_snapshot = coalesce(tl.category_name_snapshot, (select c.name from public.products p join public.categories c on c.id = p.category_id where p.id = tl.product_id)),
  base_price_cents = coalesce(tl.base_price_cents, greatest(0, tl.unit_price_cents - coalesce((select sum(coalesce((item ->> 'priceCents')::integer, (item ->> 'price_cents')::integer, 0)) from jsonb_array_elements(tl.modifiers) item), 0))),
  component_delta_cents = coalesce(tl.component_delta_cents, 0),
  modifier_delta_cents = coalesce(tl.modifier_delta_cents, coalesce((select sum(coalesce((item ->> 'priceCents')::integer, (item ->> 'price_cents')::integer, 0)) from jsonb_array_elements(tl.modifiers) item), 0)),
  gross_before_discount_cents = coalesce(tl.gross_before_discount_cents, tl.unit_price_cents)
where tl.product_id is not null;

-- Populate quick-sale snapshots/components from the immutable offline event before/after line insertion.
create or replace function public.capture_ticket_line_catalog_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
declare line_payload jsonb; snapshot_payload jsonb;
begin
  select line into line_payload from public.offline_event_log e
  cross join lateral jsonb_array_elements(e.payload -> 'lines') line
  where e.tenant_id = new.tenant_id and e.payload -> 'ticket' ->> 'id' = new.ticket_id::text and line ->> 'id' = new.id::text
  order by e.created_at desc limit 1;
  snapshot_payload := line_payload -> 'catalogSnapshot';
  if snapshot_payload is null then
    select (array_agg(ol.catalog_snapshot order by ol.updated_at desc))[1] into snapshot_payload
    from public.order_lines ol join public.orders o on o.id = ol.order_id join public.tickets t on t.id = new.ticket_id
    where ol.tenant_id = new.tenant_id and o.cash_session_id = t.cash_session_id and o.venue_id = t.venue_id
      and ol.product_id is not distinct from new.product_id and ol.variant_id is not distinct from new.variant_id
      and ol.unit_price_cents = new.unit_price_cents and ol.catalog_snapshot <> '{}'::jsonb
    having count(*) = 1;
  end if;
  if snapshot_payload is not null then
    new.sale_format_id := nullif(snapshot_payload ->> 'saleFormatId', '')::uuid;
    new.sale_format_name_snapshot := nullif(snapshot_payload ->> 'saleFormatName', '');
    new.category_id_snapshot := nullif(snapshot_payload ->> 'categoryId', '')::uuid;
    new.category_name_snapshot := nullif(snapshot_payload ->> 'categoryName', '');
    new.catalog_tab_id_snapshot := nullif(snapshot_payload ->> 'catalogTabId', '')::uuid;
    new.catalog_tab_name_snapshot := nullif(snapshot_payload ->> 'catalogTabName', '');
  end if;
  if line_payload is not null then
    new.base_price_cents := nullif(line_payload ->> 'basePriceCents', '')::integer;
    new.component_delta_cents := coalesce(nullif(line_payload ->> 'componentDeltaCents', '')::integer, 0);
    new.modifier_delta_cents := coalesce(nullif(line_payload ->> 'modifierDeltaCents', '')::integer, 0);
    new.gross_before_discount_cents := coalesce(nullif(line_payload ->> 'grossBeforeDiscountCents', '')::integer, new.unit_price_cents);
  end if;
  if new.sale_format_id is null then select sale_format_id into new.sale_format_id from public.product_variants where id = new.variant_id; end if;
  if new.sale_format_name_snapshot is null then select label into new.sale_format_name_snapshot from public.sale_formats where id = new.sale_format_id; end if;
  if new.category_id_snapshot is null then select category_id into new.category_id_snapshot from public.products where id = new.product_id; end if;
  if new.category_name_snapshot is null then select name into new.category_name_snapshot from public.categories where id = new.category_id_snapshot; end if;
  new.base_price_cents := coalesce(new.base_price_cents, new.unit_price_cents);
  new.component_delta_cents := coalesce(new.component_delta_cents, 0);
  new.modifier_delta_cents := coalesce(new.modifier_delta_cents, 0);
  new.gross_before_discount_cents := coalesce(new.gross_before_discount_cents, new.unit_price_cents);
  return new;
end;
$$;
drop trigger if exists capture_ticket_line_catalog_snapshot on public.ticket_lines;
create trigger capture_ticket_line_catalog_snapshot before insert on public.ticket_lines for each row execute function public.capture_ticket_line_catalog_snapshot();

create or replace function public.capture_ticket_line_components()
returns trigger language plpgsql security definer set search_path = public as $$
declare components_payload jsonb;
begin
  select line -> 'components' into components_payload from public.offline_event_log e
  cross join lateral jsonb_array_elements(e.payload -> 'lines') line
  where e.tenant_id = new.tenant_id and e.payload -> 'ticket' ->> 'id' = new.ticket_id::text and line ->> 'id' = new.id::text
  order by e.created_at desc limit 1;
  if components_payload is null then
    -- Restaurant payment RPCs predate components and do not expose source_order_line_id.
    -- Copy only when the source is unambiguous; verification reports anything left unresolved.
    select (array_agg(ol.components order by ol.updated_at desc))[1] into components_payload
    from public.order_lines ol join public.orders o on o.id = ol.order_id
    join public.tickets t on t.id = new.ticket_id
    where ol.tenant_id = new.tenant_id and o.cash_session_id = t.cash_session_id and o.venue_id = t.venue_id
      and ol.product_id is not distinct from new.product_id and ol.variant_id is not distinct from new.variant_id
      and ol.product_name = new.product_name and ol.variant_name = new.variant_name
      and ol.unit_price_cents = new.unit_price_cents and jsonb_array_length(ol.components) > 0
    having count(*) = 1;
  end if;
  if jsonb_typeof(components_payload) = 'array' then
    insert into public.ticket_line_components (tenant_id, ticket_line_id, component_type, selection_group_id, selection_group_name_snapshot, product_id, variant_id, product_name_snapshot, variant_name_snapshot, quantity, price_delta_cents, sort_order, metadata)
    select new.tenant_id, new.id, c.type, nullif(c."selectionGroupId", '')::uuid, coalesce(c."selectionGroupName", ''),
      nullif(c."productId", '')::uuid, nullif(c."variantId", '')::uuid, c."productName", coalesce(c."variantName", ''),
      greatest(c.quantity, 1), greatest(c."priceDeltaCents", 0), c."sortOrder",
      coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('modifiers', coalesce(c.modifiers, '[]'::jsonb))
    from jsonb_to_recordset(components_payload) c(type text, "selectionGroupId" text, "selectionGroupName" text, "productId" text, "variantId" text, "productName" text, "variantName" text, quantity integer, "priceDeltaCents" integer, "sortOrder" integer, modifiers jsonb, metadata jsonb);
  end if;
  return new;
end;
$$;
drop trigger if exists capture_ticket_line_components on public.ticket_lines;
create trigger capture_ticket_line_components after insert on public.ticket_lines for each row execute function public.capture_ticket_line_components();

create or replace function public.canonical_catalog_component_modifiers(
  p_product_id uuid,
  p_variant_id uuid,
  p_submitted jsonb
) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'groupId', mg.id, 'name', m.name, 'priceCents', m.price_cents
  ) order by mg.sort_order, m.sort_order), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_submitted, '[]'::jsonb)) submitted
  join public.modifiers m on m.id = nullif(submitted ->> 'id', '')::uuid and m.is_active
  join public.modifier_groups mg on mg.id = m.group_id and mg.is_active
  where mg.product_id = p_product_id or exists (
    select 1 from public.product_modifier_groups pmg
    where pmg.product_id = p_product_id and pmg.modifier_group_id = mg.id
      and (pmg.variant_id is null or pmg.variant_id = p_variant_id)
  );
$$;

-- v3 preserves the proven legacy revision/served-line behavior, then validates and stores normalized components.
create or replace function public.save_restaurant_order_lines_v3(p_order_id uuid, p_expected_revision integer, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; line_item jsonb; line_id uuid; variant_id_value uuid; canonical_components jsonb; component_count integer; sent_count integer; result_lines jsonb;
begin
  result := public.save_restaurant_order_lines(p_order_id, p_expected_revision, p_lines);
  for line_item in select value from jsonb_array_elements(p_lines) loop
    line_id := (line_item ->> 'id')::uuid;
    variant_id_value := (line_item ->> 'variantId')::uuid;
    sent_count := jsonb_array_length(coalesce(line_item -> 'components', '[]'::jsonb));
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', sgi.id, 'type', sg.kind, 'selectionGroupId', sg.id, 'selectionGroupName', sg.name,
      'productId', p.id, 'variantId', sgi.variant_id, 'productName', p.name,
      'variantName', coalesce(pv.name, ''), 'quantity', 1, 'priceDeltaCents', sgi.price_delta_cents,
      'sortOrder', sgi.sort_order, 'modifiers', public.canonical_catalog_component_modifiers(p.id, pv.id, c -> 'modifiers')) order by sg.sort_order, sgi.sort_order), '[]'::jsonb), count(*)::integer
    into canonical_components, component_count
    from jsonb_array_elements(coalesce(line_item -> 'components', '[]'::jsonb)) c
    join public.variant_selection_groups vsg on vsg.variant_id = variant_id_value
    join public.selection_groups sg on sg.id = vsg.selection_group_id and sg.is_active
    join public.selection_group_items sgi on sgi.group_id = sg.id and sgi.is_active
      and sgi.product_id = nullif(c ->> 'productId', '')::uuid
      and (nullif(c ->> 'selectionGroupId', '') is null or sg.id = nullif(c ->> 'selectionGroupId', '')::uuid)
      and (c ->> 'id' !~ '^[0-9a-fA-F-]{36}$' or sgi.id = (c ->> 'id')::uuid)
    join public.products p on p.id = sgi.product_id and p.is_active
    left join lateral (
      select candidate.id, candidate.name from public.product_variants candidate
      where candidate.product_id = p.id and candidate.is_active
      order by (candidate.id = sgi.variant_id) desc, candidate.is_default desc, candidate.sort_order, candidate.id
      limit 1
    ) pv on true;
    if component_count <> sent_count then raise exception 'La seleccion contiene componentes no permitidos'; end if;
    if exists (
      select 1 from public.variant_selection_groups vsg join public.selection_groups sg on sg.id = vsg.selection_group_id and sg.is_active
      left join lateral (select count(*)::integer amount from jsonb_array_elements(canonical_components) c where c ->> 'selectionGroupId' = sg.id::text) chosen on true
      where vsg.variant_id = variant_id_value and (chosen.amount < sg.min_select or chosen.amount > sg.max_select)
    ) then raise exception 'La seleccion no cumple los minimos y maximos configurados'; end if;
    if exists (
      select 1 from jsonb_array_elements(canonical_components) canonical
      join lateral (
        select submitted -> 'modifiers' modifiers
        from jsonb_array_elements(coalesce(line_item -> 'components', '[]'::jsonb)) submitted
        where submitted ->> 'id' = canonical ->> 'id' limit 1
      ) source on true
      where jsonb_array_length(coalesce(canonical -> 'modifiers', '[]'::jsonb))
        <> jsonb_array_length(coalesce(source.modifiers, '[]'::jsonb))
    ) then raise exception 'La seleccion contiene modificadores de componente no permitidos'; end if;
    if exists (
      select 1 from jsonb_array_elements(canonical_components) component
      join public.modifier_groups mg on mg.is_active and (
        mg.product_id = (component ->> 'productId')::uuid or exists (
          select 1 from public.product_modifier_groups pmg
          where pmg.product_id = (component ->> 'productId')::uuid and pmg.modifier_group_id = mg.id
            and (pmg.variant_id is null or pmg.variant_id = nullif(component ->> 'variantId', '')::uuid)
        )
      )
      left join lateral (
        select count(*)::integer amount from jsonb_array_elements(coalesce(component -> 'modifiers', '[]'::jsonb)) selected
        where selected ->> 'groupId' = mg.id::text
      ) chosen on true
      where chosen.amount < mg.min_select or chosen.amount > mg.max_select
    ) then raise exception 'Los modificadores del componente no cumplen los limites configurados'; end if;
    update public.order_lines ol set components = canonical_components,
      catalog_snapshot = coalesce(line_item -> 'catalogSnapshot', '{}'::jsonb),
      unit_price_cents = (select pv.price_cents from public.product_variants pv where pv.id = variant_id_value)
        + coalesce((select sum(coalesce((m ->> 'priceCents')::integer, 0)) from jsonb_array_elements(ol.modifiers) m), 0)
        + coalesce((select sum((c ->> 'priceDeltaCents')::integer) from jsonb_array_elements(canonical_components) c), 0)
        + coalesce((select sum((m ->> 'priceCents')::integer) from jsonb_array_elements(canonical_components) c cross join lateral jsonb_array_elements(coalesce(c -> 'modifiers', '[]'::jsonb)) m), 0)
    where ol.id = line_id and ol.order_id = p_order_id;
    delete from public.order_line_components where order_line_id = line_id;
    insert into public.order_line_components (tenant_id, venue_id, order_line_id, component_type, selection_group_id, product_id, variant_id, product_name_snapshot, variant_name_snapshot, quantity, price_delta_cents, sort_order, metadata)
    select ol.tenant_id, ol.venue_id, ol.id, c.type, nullif(c."selectionGroupId", '')::uuid, nullif(c."productId", '')::uuid,
      nullif(c."variantId", '')::uuid, c."productName", c."variantName", c.quantity, c."priceDeltaCents", c."sortOrder", jsonb_build_object('modifiers', coalesce(c.modifiers, '[]'::jsonb))
    from public.order_lines ol cross join jsonb_to_recordset(canonical_components) c(type text, "selectionGroupId" text, "productId" text, "variantId" text, "productName" text, "variantName" text, quantity integer, "priceDeltaCents" integer, "sortOrder" integer, modifiers jsonb)
    where ol.id = line_id;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ol.id, 'tenantId', ol.tenant_id, 'venueId', ol.venue_id, 'orderId', ol.order_id,
    'productId', ol.product_id, 'variantId', ol.variant_id, 'productName', ol.product_name,
    'variantName', ol.variant_name, 'unitPriceCents', ol.unit_price_cents, 'quantity', ol.quantity,
    'servedQuantity', ol.served_quantity, 'fullyServedAt', ol.fully_served_at, 'modifiers', ol.modifiers,
    'components', ol.components, 'catalogSnapshot', ol.catalog_snapshot, 'mixerProductId', ol.mixer_product_id, 'mixer', ol.mixer,
    'note', ol.note, 'createdAt', ol.created_at, 'updatedAt', ol.updated_at
  ) order by ol.created_at), '[]'::jsonb) into result_lines from public.order_lines ol where ol.order_id = p_order_id;
  return jsonb_build_object('revision', (result ->> 'revision')::integer, 'lines', result_lines);
end;
$$;

-- RLS follows the existing admin-write / authorised-venue-read convention.
alter table public.catalog_tabs enable row level security;
alter table public.catalog_placements enable row level security;
alter table public.selection_groups enable row level security;
alter table public.selection_group_items enable row level security;
alter table public.variant_selection_groups enable row level security;
alter table public.product_modifier_groups enable row level security;
alter table public.ticket_line_components enable row level security;
alter table public.order_line_components enable row level security;

create policy "catalog_tabs_select" on public.catalog_tabs for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy "catalog_tabs_admin_manage" on public.catalog_tabs for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy "catalog_placements_select" on public.catalog_placements for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy "catalog_placements_admin_manage" on public.catalog_placements for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy "selection_groups_select" on public.selection_groups for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy "selection_groups_admin_manage" on public.selection_groups for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy "selection_group_items_select" on public.selection_group_items for select to authenticated using (exists (select 1 from public.selection_groups sg where sg.id = group_id and (public.user_is_tenant_admin(sg.tenant_id) or public.user_has_venue_access(sg.tenant_id, sg.venue_id))));
create policy "selection_group_items_admin_manage" on public.selection_group_items for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy "variant_selection_groups_select" on public.variant_selection_groups for select to authenticated using (exists (select 1 from public.product_variants pv join public.products p on p.id = pv.product_id where pv.id = variant_id and (public.user_is_tenant_admin(p.tenant_id) or public.user_has_venue_access(p.tenant_id, p.venue_id))));
create policy "variant_selection_groups_admin_manage" on public.variant_selection_groups for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy "product_modifier_groups_select" on public.product_modifier_groups for select to authenticated using (exists (select 1 from public.products p where p.id = product_id and (public.user_is_tenant_admin(p.tenant_id) or public.user_has_venue_access(p.tenant_id, p.venue_id))));
create policy "product_modifier_groups_admin_manage" on public.product_modifier_groups for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
create policy "ticket_line_components_select" on public.ticket_line_components for select to authenticated using (exists (select 1 from public.ticket_lines tl join public.tickets t on t.id = tl.ticket_id where tl.id = ticket_line_id and public.user_can_view_device(t.tenant_id, t.venue_id, t.device_id)));
create policy "order_line_components_select" on public.order_line_components for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

revoke all on public.catalog_tabs, public.catalog_placements, public.selection_groups, public.selection_group_items, public.variant_selection_groups, public.product_modifier_groups, public.ticket_line_components, public.order_line_components from anon;
grant select on public.catalog_tabs, public.catalog_placements, public.selection_groups, public.selection_group_items, public.variant_selection_groups, public.product_modifier_groups, public.ticket_line_components, public.order_line_components to authenticated;
grant insert, update, delete on public.catalog_tabs, public.catalog_placements, public.selection_groups, public.selection_group_items, public.variant_selection_groups, public.product_modifier_groups to authenticated;
revoke all on function public.save_restaurant_order_lines_v3(uuid, integer, jsonb) from public, anon;
grant execute on function public.save_restaurant_order_lines_v3(uuid, integer, jsonb) to authenticated;
revoke all on function public.canonical_catalog_component_modifiers(uuid, uuid, jsonb) from public, anon, authenticated;

comment on column public.products.kind is '@deprecated: compatibility only; use tabs, placements, variants and configured groups.';
comment on column public.products.sale_formats is '@deprecated: compatibility/backfill only; use product_variants.sale_format_id and catalog_placements.';
comment on column public.products.can_use_as_mixer is '@deprecated: compatibility/backfill only; use selection_group_items.';
comment on column public.products.mixer_supplement_cents is '@deprecated: compatibility/backfill only; use selection_group_items.price_delta_cents.';
comment on column public.categories.kind is '@deprecated: compatibility only; categories are visual organisation.';
comment on table public.ticket_line_components is 'Immutable product components selected as mixers or menu items; never synthetic modifiers.';

commit;
