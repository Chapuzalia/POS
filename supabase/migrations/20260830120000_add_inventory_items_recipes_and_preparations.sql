-- Inventory V2: physical inventory items, variant recipes and explicit preparations.
--
-- This migration deliberately replaces the product-based consumption path. Existing
-- inventory-enabled products are converted to physical inventory_items and every
-- existing variant receives a one-line inherited recipe, preserving sale-format
-- consumption defaults without copying them.

drop trigger if exists consume_ticket_line_inventory on public.ticket_lines;

drop function if exists public.consume_inventory_product(uuid, uuid, uuid, uuid, uuid, numeric, text);
drop function if exists public.consume_inventory_product(uuid, uuid, uuid, uuid, uuid, uuid, numeric, text);
drop function if exists public.set_inventory_product_stock(uuid, uuid, uuid, uuid, jsonb);
drop function if exists public.set_inventory_product_stock(uuid, uuid, uuid, uuid, numeric, uuid, jsonb);
drop function if exists public.set_inventory_product_stock(uuid, uuid, uuid, uuid, numeric, uuid, jsonb, jsonb);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  description text not null default '',
  base_unit_id uuid not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_items_name_check check (btrim(name) <> '' and char_length(name) <= 120),
  constraint inventory_items_description_check check (char_length(description) <= 500),
  constraint inventory_items_scope_unique unique (id, tenant_id, venue_id),
  constraint inventory_items_base_unit_scope_fk
    foreign key (base_unit_id, tenant_id, venue_id)
    references public.inventory_units(id, tenant_id, venue_id)
);

create unique index inventory_items_venue_name_unique
  on public.inventory_items (tenant_id, venue_id, lower(name));
create index inventory_items_venue_active_idx
  on public.inventory_items (tenant_id, venue_id, is_active, name);

-- A physical item is created only for products that were already configured in
-- inventory. Products without physical stock remain catalog-only.
insert into public.inventory_items (
  id, tenant_id, venue_id, name, description, base_unit_id, is_active, created_at, updated_at
)
select
  s.product_id,
  s.tenant_id,
  s.venue_id,
  p.name,
  coalesce(p.description, ''),
  s.unit_id,
  p.is_active,
  s.created_at,
  s.updated_at
from public.inventory_product_settings s
join public.products p
  on p.id = s.product_id
 and p.tenant_id = s.tenant_id
 and p.venue_id = s.venue_id
on conflict (id) do nothing;

alter table public.inventory_stock_levels
  add column inventory_item_id uuid;

update public.inventory_stock_levels
set inventory_item_id = product_id
where inventory_item_id is null;

alter table public.inventory_stock_levels
  drop constraint if exists inventory_stock_levels_pkey,
  drop constraint if exists inventory_stock_levels_product_scope_fk,
  alter column inventory_item_id set not null,
  add constraint inventory_stock_levels_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id)
    on delete cascade,
  add constraint inventory_stock_levels_pkey primary key (warehouse_id, inventory_item_id);

drop index if exists public.inventory_stock_levels_product_idx;
create index inventory_stock_levels_item_idx
  on public.inventory_stock_levels (tenant_id, venue_id, inventory_item_id);

alter table public.inventory_stock_levels drop column product_id;

alter table public.inventory_stock_movements
  add column inventory_item_id uuid,
  add column unit_id uuid,
  add column source_id uuid,
  add column production_id uuid,
  add column metadata jsonb not null default '{}'::jsonb;

update public.inventory_stock_movements m
set inventory_item_id = m.product_id,
    unit_id = i.base_unit_id
from public.inventory_items i
where i.id = m.product_id
  and i.tenant_id = m.tenant_id
  and i.venue_id = m.venue_id;

-- Some installations retain movement history after the product's inventory
-- configuration was removed. Those rows have no safe physical unit to infer.
-- Keep their legacy product trace nullable instead of inventing an item/unit;
-- every V2 movement written below always supplies both new identity columns.

alter table public.inventory_stock_movements
  drop constraint if exists inventory_stock_movements_source_type_check,
  drop constraint if exists inventory_stock_movements_delta_check,
  alter column product_id drop not null,
  alter column ticket_line_id drop not null,
  alter column sale_format_id drop not null,
  alter column format_consumption_quantity drop not null,
  alter column sold_quantity drop not null,
  alter column content_unit_id drop not null,
  add constraint inventory_stock_movements_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id),
  add constraint inventory_stock_movements_unit_scope_fk
    foreign key (unit_id, tenant_id, venue_id)
    references public.inventory_units(id, tenant_id, venue_id),
  add constraint inventory_stock_movements_v2_identity_check
    check (
      (inventory_item_id is not null and unit_id is not null)
      or (inventory_item_id is null and unit_id is null and product_id is not null)
    ),
  add constraint inventory_stock_movements_balance_check
    check (
      stock_quantity_delta <> 0
      and stock_quantity_before + stock_quantity_delta = stock_quantity_after
    );

create index inventory_stock_movements_item_created_idx
  on public.inventory_stock_movements (tenant_id, venue_id, inventory_item_id, created_at desc);

alter table public.inventory_consumption_failures
  add column if not exists inventory_item_id uuid,
  add column if not exists details jsonb not null default '{}'::jsonb;

create table public.inventory_item_warehouse_routes (
  inventory_item_id uuid not null,
  warehouse_id uuid not null,
  tenant_id uuid not null,
  venue_id uuid not null,
  priority integer not null default 1,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (inventory_item_id, warehouse_id),
  constraint inventory_item_routes_priority_check check (priority between 1 and 9999),
  constraint inventory_item_routes_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id) on delete cascade,
  constraint inventory_item_routes_warehouse_scope_fk
    foreign key (warehouse_id, tenant_id, venue_id)
    references public.inventory_warehouses(id, tenant_id, venue_id) on delete cascade
);

create unique index inventory_item_routes_enabled_priority_unique
  on public.inventory_item_warehouse_routes (inventory_item_id, priority)
  where is_enabled;
create index inventory_item_routes_venue_idx
  on public.inventory_item_warehouse_routes (tenant_id, venue_id, inventory_item_id, is_enabled, priority);

-- Device routing was consumption authority in V1. V2 derives a deterministic,
-- device-independent route from the physical stock locations themselves.
insert into public.inventory_item_warehouse_routes (
  inventory_item_id, warehouse_id, tenant_id, venue_id, priority, is_enabled
)
select
  l.inventory_item_id,
  l.warehouse_id,
  l.tenant_id,
  l.venue_id,
  row_number() over (
    partition by l.inventory_item_id
    order by w.sort_order, w.name, w.id
  ),
  l.is_enabled
from public.inventory_stock_levels l
join public.inventory_warehouses w
  on w.id = l.warehouse_id
 and w.tenant_id = l.tenant_id
 and w.venue_id = l.venue_id
on conflict (inventory_item_id, warehouse_id) do nothing;

create table public.inventory_recipes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  variant_id uuid not null,
  mode text not null default 'recipe',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_recipes_mode_check check (mode in ('direct', 'recipe')),
  constraint inventory_recipes_scope_unique unique (id, tenant_id, venue_id),
  constraint inventory_recipes_variant_unique unique (variant_id),
  constraint inventory_recipes_variant_fk
    foreign key (variant_id)
    references public.product_variants(id) on delete cascade
);

create table public.inventory_recipe_lines (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null,
  tenant_id uuid not null,
  venue_id uuid not null,
  inventory_item_id uuid not null,
  quantity numeric(18, 6),
  unit_id uuid,
  uses_format_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_recipe_lines_scope_unique unique (id, tenant_id, venue_id),
  constraint inventory_recipe_lines_quantity_check check (
    (uses_format_default and quantity is null and unit_id is null)
    or (not uses_format_default and quantity > 0 and unit_id is not null)
  ),
  constraint inventory_recipe_lines_sort_check check (sort_order >= 0),
  constraint inventory_recipe_lines_recipe_scope_fk
    foreign key (recipe_id, tenant_id, venue_id)
    references public.inventory_recipes(id, tenant_id, venue_id) on delete cascade,
  constraint inventory_recipe_lines_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id),
  constraint inventory_recipe_lines_unit_scope_fk
    foreign key (unit_id, tenant_id, venue_id)
    references public.inventory_units(id, tenant_id, venue_id)
);

create index inventory_recipe_lines_recipe_idx
  on public.inventory_recipe_lines (recipe_id, sort_order, id);
create index inventory_recipe_lines_item_idx
  on public.inventory_recipe_lines (tenant_id, venue_id, inventory_item_id);

-- Existing configured products become direct consumption recipes. The line keeps
-- a live reference to the sale-format default, so later format edits are inherited.
insert into public.inventory_recipes (tenant_id, venue_id, variant_id, mode, is_active)
select i.tenant_id, i.venue_id, v.id, 'direct', true
from public.inventory_items i
join public.product_variants v
  on v.product_id = i.id
 and v.tenant_id = i.tenant_id
 and v.venue_id = i.venue_id
on conflict (variant_id) do nothing;

insert into public.inventory_recipe_lines (
  recipe_id, tenant_id, venue_id, inventory_item_id,
  quantity, unit_id, uses_format_default, sort_order
)
select r.id, r.tenant_id, r.venue_id, v.product_id, null, null, true, 0
from public.inventory_recipes r
join public.product_variants v
  on v.id = r.variant_id
 and v.tenant_id = r.tenant_id
 and v.venue_id = r.venue_id
where r.mode = 'direct'
  and not exists (
    select 1 from public.inventory_recipe_lines line where line.recipe_id = r.id
  );

create table public.modifier_inventory_effects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  modifier_id uuid not null,
  operation text not null,
  inventory_item_id uuid not null,
  quantity numeric(18, 6),
  unit_id uuid,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint modifier_inventory_effects_operation_check check (operation in ('ADD', 'REMOVE')),
  constraint modifier_inventory_effects_quantity_check check (
    (operation = 'REMOVE' and quantity is null and unit_id is null)
    or (operation = 'ADD' and quantity > 0 and unit_id is not null)
  ),
  constraint modifier_inventory_effects_scope_unique unique (id, tenant_id, venue_id),
  constraint modifier_inventory_effects_modifier_fk
    foreign key (modifier_id)
    references public.modifiers(id) on delete cascade,
  constraint modifier_inventory_effects_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id),
  constraint modifier_inventory_effects_unit_scope_fk
    foreign key (unit_id, tenant_id, venue_id)
    references public.inventory_units(id, tenant_id, venue_id)
);

create index modifier_inventory_effects_modifier_idx
  on public.modifier_inventory_effects (modifier_id, sort_order, id);

create table public.inventory_production_recipes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  inventory_item_id uuid not null,
  production_warehouse_id uuid not null,
  reference_quantity numeric(18, 6) not null,
  reference_unit_id uuid not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_production_recipes_reference_check check (reference_quantity > 0),
  constraint inventory_production_recipes_scope_unique unique (id, tenant_id, venue_id),
  constraint inventory_production_recipes_item_unique unique (inventory_item_id),
  constraint inventory_production_recipes_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id) on delete cascade,
  constraint inventory_production_recipes_warehouse_scope_fk
    foreign key (production_warehouse_id, tenant_id, venue_id)
    references public.inventory_warehouses(id, tenant_id, venue_id),
  constraint inventory_production_recipes_unit_scope_fk
    foreign key (reference_unit_id, tenant_id, venue_id)
    references public.inventory_units(id, tenant_id, venue_id)
);

create table public.inventory_production_recipe_lines (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null,
  tenant_id uuid not null,
  venue_id uuid not null,
  inventory_item_id uuid not null,
  quantity numeric(18, 6) not null,
  unit_id uuid not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_production_recipe_lines_quantity_check check (quantity > 0),
  constraint inventory_production_recipe_lines_scope_unique unique (id, tenant_id, venue_id),
  constraint inventory_production_recipe_lines_recipe_scope_fk
    foreign key (recipe_id, tenant_id, venue_id)
    references public.inventory_production_recipes(id, tenant_id, venue_id) on delete cascade,
  constraint inventory_production_recipe_lines_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id),
  constraint inventory_production_recipe_lines_unit_scope_fk
    foreign key (unit_id, tenant_id, venue_id)
    references public.inventory_units(id, tenant_id, venue_id)
);

create index inventory_production_recipe_lines_recipe_idx
  on public.inventory_production_recipe_lines (recipe_id, sort_order, id);

create table public.inventory_productions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  inventory_item_id uuid not null,
  warehouse_id uuid not null,
  quantity numeric(18, 6) not null,
  unit_id uuid not null,
  stock_quantity numeric(18, 6) not null,
  recipe_id uuid not null,
  recipe_snapshot jsonb not null,
  user_id uuid not null,
  device_id uuid,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  constraint inventory_productions_quantity_check check (quantity > 0 and stock_quantity > 0),
  constraint inventory_productions_request_unique unique (venue_id, request_id),
  constraint inventory_productions_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id),
  constraint inventory_productions_warehouse_scope_fk
    foreign key (warehouse_id, tenant_id, venue_id)
    references public.inventory_warehouses(id, tenant_id, venue_id),
  constraint inventory_productions_unit_scope_fk
    foreign key (unit_id, tenant_id, venue_id)
    references public.inventory_units(id, tenant_id, venue_id),
  constraint inventory_productions_recipe_scope_fk
    foreign key (recipe_id, tenant_id, venue_id)
    references public.inventory_production_recipes(id, tenant_id, venue_id)
);

alter table public.inventory_stock_movements
  add constraint inventory_stock_movements_production_fk
  foreign key (production_id) references public.inventory_productions(id);

create index inventory_productions_item_created_idx
  on public.inventory_productions (tenant_id, venue_id, inventory_item_id, created_at desc);

-- Product identity is no longer the physical inventory identity.
drop table if exists public.inventory_product_format_consumptions;
drop table public.inventory_product_settings;

drop trigger if exists prevent_inventory_unit_equivalence_change_with_stock on public.inventory_units;
create or replace function public.prevent_inventory_unit_equivalence_change_with_stock()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if (
    old.content_quantity is distinct from new.content_quantity
    or old.content_unit_id is distinct from new.content_unit_id
  ) and exists (
    select 1
    from public.inventory_items i
    join public.inventory_stock_levels l
      on l.inventory_item_id = i.id
     and l.tenant_id = i.tenant_id
     and l.venue_id = i.venue_id
    where i.base_unit_id = old.id
      and i.tenant_id = old.tenant_id
      and i.venue_id = old.venue_id
      and l.quantity <> 0
  ) then
    raise exception 'INVENTORY_UNIT_CHANGE_WITH_STOCK' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger prevent_inventory_unit_equivalence_change_with_stock
before update of content_quantity, content_unit_id on public.inventory_units
for each row execute function public.prevent_inventory_unit_equivalence_change_with_stock();

create or replace function public.inventory_units_compatible(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_left_unit_id uuid,
  p_right_unit_id uuid
)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce((
    select
      left_unit.content_unit_id = right_unit.content_unit_id
      or lower(btrim(left_base.name)) = lower(btrim(right_base.name))
      or (
        btrim(left_base.symbol) <> ''
        and lower(btrim(left_base.symbol)) = lower(btrim(right_base.symbol))
      )
      or (
        left_base.decimal_places = 0
        and right_base.decimal_places = 0
        and (
          lower(left_base.name) ~ '(unidad|pieza|botell|lata|envase)'
          or lower(left_base.symbol) ~ '^(u|ud|uds|pz|bot)$'
        )
        and (
          lower(right_base.name) ~ '(unidad|pieza|botell|lata|envase)'
          or lower(right_base.symbol) ~ '^(u|ud|uds|pz|bot)$'
        )
      )
    from public.inventory_units left_unit
    join public.inventory_units left_base
      on left_base.id = left_unit.content_unit_id
     and left_base.tenant_id = left_unit.tenant_id
     and left_base.venue_id = left_unit.venue_id
    join public.inventory_units right_unit
      on right_unit.id = p_right_unit_id
     and right_unit.tenant_id = left_unit.tenant_id
     and right_unit.venue_id = left_unit.venue_id
    join public.inventory_units right_base
      on right_base.id = right_unit.content_unit_id
     and right_base.tenant_id = right_unit.tenant_id
     and right_base.venue_id = right_unit.venue_id
    where left_unit.id = p_left_unit_id
      and left_unit.tenant_id = p_tenant_id
      and left_unit.venue_id = p_venue_id
  ), false)
$$;

create or replace function public.inventory_convert_quantity(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_quantity numeric,
  p_from_unit_id uuid,
  p_to_unit_id uuid
)
returns numeric
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_from_content numeric(18, 6);
  v_to_content numeric(18, 6);
begin
  if p_quantity is null or p_quantity < 0 then
    raise exception 'INVENTORY_INVALID_QUANTITY' using errcode = '22023';
  end if;
  if not public.inventory_units_compatible(
    p_tenant_id, p_venue_id, p_from_unit_id, p_to_unit_id
  ) then
    raise exception 'INVENTORY_UNIT_MISMATCH from=% to=%', p_from_unit_id, p_to_unit_id
      using errcode = '22023';
  end if;
  select content_quantity into v_from_content
  from public.inventory_units
  where id = p_from_unit_id and tenant_id = p_tenant_id and venue_id = p_venue_id;
  select content_quantity into v_to_content
  from public.inventory_units
  where id = p_to_unit_id and tenant_id = p_tenant_id and venue_id = p_venue_id;
  return round(p_quantity * v_from_content / v_to_content, 6);
end;
$$;

create or replace function public.consume_inventory_item(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_stock_quantity numeric,
  p_ticket_line_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_metadata jsonb default '{}'::jsonb,
  p_production_id uuid default null
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_remaining numeric(18, 6) := round(coalesce(p_stock_quantity, 0), 6);
  v_take numeric(18, 6);
  v_unit_id uuid;
  v_stock record;
  v_overflow_warehouse_id uuid;
  v_overflow_quantity numeric(18, 6);
begin
  if v_remaining <= 0 then return; end if;

  select base_unit_id into v_unit_id
  from public.inventory_items
  where id = p_inventory_item_id
    and tenant_id = p_tenant_id
    and venue_id = p_venue_id
    and is_active;
  if v_unit_id is null then
    raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;

  for v_stock in
    select l.warehouse_id, l.quantity
    from public.inventory_item_warehouse_routes route
    join public.inventory_warehouses w
      on w.id = route.warehouse_id
     and w.tenant_id = route.tenant_id
     and w.venue_id = route.venue_id
    join public.inventory_stock_levels l
      on l.inventory_item_id = route.inventory_item_id
     and l.warehouse_id = route.warehouse_id
     and l.tenant_id = route.tenant_id
     and l.venue_id = route.venue_id
    where route.inventory_item_id = p_inventory_item_id
      and route.tenant_id = p_tenant_id
      and route.venue_id = p_venue_id
      and route.is_enabled
      and w.is_active
      and l.is_enabled
      and l.quantity > 0
    order by route.priority, w.sort_order, w.name, w.id
    for update of l
  loop
    v_take := least(v_remaining, v_stock.quantity);
    update public.inventory_stock_levels
    set quantity = quantity - v_take, updated_at = now()
    where warehouse_id = v_stock.warehouse_id
      and inventory_item_id = p_inventory_item_id;

    insert into public.inventory_stock_movements (
      tenant_id, venue_id, warehouse_id, inventory_item_id, product_id,
      ticket_line_id, sale_format_id, source_type, source_id, production_id,
      stock_quantity_delta, stock_quantity_before, stock_quantity_after,
      format_consumption_quantity, sold_quantity, content_unit_id, unit_id, metadata
    ) values (
      p_tenant_id, p_venue_id, v_stock.warehouse_id, p_inventory_item_id,
      nullif(p_metadata ->> 'catalogProductId', '')::uuid,
      p_ticket_line_id, nullif(p_metadata ->> 'saleFormatId', '')::uuid,
      p_source_type, p_source_id, p_production_id,
      -v_take, v_stock.quantity, v_stock.quantity - v_take,
      nullif(p_metadata ->> 'recipeQuantity', '')::numeric,
      nullif(p_metadata ->> 'soldQuantity', '')::numeric,
      v_unit_id, v_unit_id, coalesce(p_metadata, '{}'::jsonb)
    );
    v_remaining := round(v_remaining - v_take, 6);
    exit when v_remaining <= 0;
  end loop;

  if v_remaining <= 0 then return; end if;

  select route.warehouse_id, coalesce(l.quantity, 0) quantity
  into v_overflow_warehouse_id, v_overflow_quantity
  from public.inventory_item_warehouse_routes route
  join public.inventory_warehouses w
    on w.id = route.warehouse_id
   and w.tenant_id = route.tenant_id
   and w.venue_id = route.venue_id
  left join public.inventory_stock_levels l
    on l.inventory_item_id = route.inventory_item_id
   and l.warehouse_id = route.warehouse_id
   and l.tenant_id = route.tenant_id
   and l.venue_id = route.venue_id
  where route.inventory_item_id = p_inventory_item_id
    and route.tenant_id = p_tenant_id
    and route.venue_id = p_venue_id
    and route.is_enabled
    and w.is_active
    and coalesce(l.is_enabled, true)
  order by route.priority, w.sort_order, w.name, w.id
  limit 1;

  if v_overflow_warehouse_id is null then
    raise exception 'INVENTORY_ITEM_ROUTE_NOT_CONFIGURED item=%', p_inventory_item_id
      using errcode = 'P0002';
  end if;

  insert into public.inventory_stock_levels (
    warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled
  ) values (
    v_overflow_warehouse_id, p_inventory_item_id, p_tenant_id, p_venue_id,
    -v_remaining, true
  )
  on conflict (warehouse_id, inventory_item_id) do update
  set quantity = public.inventory_stock_levels.quantity - v_remaining,
      updated_at = now();

  insert into public.inventory_stock_movements (
    tenant_id, venue_id, warehouse_id, inventory_item_id, product_id,
    ticket_line_id, sale_format_id, source_type, source_id, production_id,
    stock_quantity_delta, stock_quantity_before, stock_quantity_after,
    format_consumption_quantity, sold_quantity, content_unit_id, unit_id, metadata
  ) values (
    p_tenant_id, p_venue_id, v_overflow_warehouse_id, p_inventory_item_id,
    nullif(p_metadata ->> 'catalogProductId', '')::uuid,
    p_ticket_line_id, nullif(p_metadata ->> 'saleFormatId', '')::uuid,
    p_source_type, p_source_id, p_production_id,
    -v_remaining, v_overflow_quantity, v_overflow_quantity - v_remaining,
    nullif(p_metadata ->> 'recipeQuantity', '')::numeric,
    nullif(p_metadata ->> 'soldQuantity', '')::numeric,
    v_unit_id, v_unit_id, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

create or replace function public.inventory_accumulate_variant_recipe(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_variant_id uuid,
  p_multiplier numeric,
  p_source_type text,
  p_source_id uuid
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_line record;
  v_stock_quantity numeric(18, 6);
begin
  if p_variant_id is null or coalesce(p_multiplier, 0) <= 0 then return; end if;
  for v_line in
    select
      line.inventory_item_id,
      coalesce(line.quantity, format.inventory_consumption_quantity) quantity,
      coalesce(line.unit_id, format.inventory_consumption_unit_id) unit_id,
      item.base_unit_id,
      variant.product_id,
      variant.catalog_sale_format_id,
      line.uses_format_default
    from public.inventory_recipes recipe
    join public.product_variants variant
      on variant.id = recipe.variant_id
     and variant.tenant_id = recipe.tenant_id
     and variant.venue_id = recipe.venue_id
    join public.inventory_recipe_lines line
      on line.recipe_id = recipe.id
     and line.tenant_id = recipe.tenant_id
     and line.venue_id = recipe.venue_id
    join public.inventory_items item
      on item.id = line.inventory_item_id
     and item.tenant_id = line.tenant_id
     and item.venue_id = line.venue_id
    left join public.catalog_sale_formats format
      on format.id = variant.catalog_sale_format_id
     and format.tenant_id = variant.tenant_id
     and format.venue_id = variant.venue_id
    where recipe.variant_id = p_variant_id
      and recipe.tenant_id = p_tenant_id
      and recipe.venue_id = p_venue_id
      and recipe.is_active
      and item.is_active
    order by line.sort_order, line.id
  loop
    if v_line.quantity is null or v_line.unit_id is null then continue; end if;
    v_stock_quantity := public.inventory_convert_quantity(
      p_tenant_id, p_venue_id, v_line.quantity * p_multiplier,
      v_line.unit_id, v_line.base_unit_id
    );
    insert into pg_temp.inventory_resolved_line (
      inventory_item_id, stock_quantity, sources
    ) values (
      v_line.inventory_item_id,
      v_stock_quantity,
      jsonb_build_array(jsonb_build_object(
        'type', p_source_type,
        'sourceId', p_source_id,
        'catalogProductId', v_line.product_id,
        'saleFormatId', v_line.catalog_sale_format_id,
        'recipeQuantity', v_line.quantity,
        'recipeUnitId', v_line.unit_id,
        'multiplier', p_multiplier,
        'inherited', v_line.uses_format_default
      ))
    )
    on conflict (inventory_item_id) do update
    set stock_quantity = pg_temp.inventory_resolved_line.stock_quantity + excluded.stock_quantity,
        sources = pg_temp.inventory_resolved_line.sources || excluded.sources;
  end loop;
end;
$$;

create or replace function public.consume_ticket_line_inventory()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_venue_id uuid;
  v_inventory_enabled boolean;
  v_sold_quantity numeric(18, 9);
  v_component record;
  v_modifier jsonb;
  v_modifier_row record;
  v_mixer_product_id uuid;
  v_mixer_variant_id uuid;
  v_resolved record;
  v_error_code text;
  v_error_message text;
begin
  select t.venue_id, v.inventory_enabled
  into v_venue_id, v_inventory_enabled
  from public.tickets t
  join public.venues v on v.id = t.venue_id and v.tenant_id = t.tenant_id
  where t.id = new.ticket_id and t.tenant_id = new.tenant_id;

  if v_venue_id is null then
    raise exception 'INVENTORY_TICKET_SCOPE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not v_inventory_enabled then return new; end if;

  create temporary table if not exists pg_temp.inventory_resolved_line (
    inventory_item_id uuid primary key,
    stock_quantity numeric(18, 6) not null,
    sources jsonb not null
  ) on commit drop;
  create temporary table if not exists pg_temp.inventory_selected_modifier (
    modifier_id uuid not null,
    multiplier numeric(18, 9) not null
  ) on commit drop;
  truncate pg_temp.inventory_resolved_line;
  truncate pg_temp.inventory_selected_modifier;

  v_sold_quantity := coalesce(new.allocated_quantity, new.quantity::numeric);
  perform public.inventory_accumulate_variant_recipe(
    new.tenant_id, v_venue_id, new.variant_id, v_sold_quantity, 'product', new.product_id
  );

  for v_component in
    select c.component_type, c.product_id, c.variant_id, c.quantity, c.metadata
    from public.ticket_line_components c
    where c.ticket_line_id = new.id
      and c.tenant_id = new.tenant_id
      and c.product_id is not null
  loop
    if v_component.variant_id is null then
      select id into v_component.variant_id
      from public.product_variants
      where product_id = v_component.product_id
        and tenant_id = new.tenant_id
        and venue_id = v_venue_id
        and is_active
      order by is_default desc, sort_order, id
      limit 1;
    end if;
    perform public.inventory_accumulate_variant_recipe(
      new.tenant_id,
      v_venue_id,
      v_component.variant_id,
      v_sold_quantity * v_component.quantity,
      case when v_component.component_type = 'mixer' then 'mixer' else 'menu_component' end,
      v_component.product_id
    );
    for v_modifier in
      select value from jsonb_array_elements(coalesce(v_component.metadata -> 'modifiers', '[]'::jsonb))
    loop
      if v_modifier ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        insert into pg_temp.inventory_selected_modifier values (
          (v_modifier ->> 'id')::uuid, v_sold_quantity * v_component.quantity
        );
      end if;
    end loop;
  end loop;

  for v_modifier in
    select value from jsonb_array_elements(coalesce(new.modifiers, '[]'::jsonb))
  loop
    if v_modifier ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      insert into pg_temp.inventory_selected_modifier values (
        (v_modifier ->> 'id')::uuid, v_sold_quantity
      );
    elsif v_modifier ->> 'id' ~* '^mixer:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and not exists (
        select 1 from public.ticket_line_components c
        where c.ticket_line_id = new.id and c.component_type = 'mixer'
      )
    then
      v_mixer_product_id := substring(v_modifier ->> 'id' from 7)::uuid;
      select id into v_mixer_variant_id
      from public.product_variants
      where product_id = v_mixer_product_id
        and tenant_id = new.tenant_id
        and venue_id = v_venue_id
        and is_active
      order by is_default desc, sort_order, id
      limit 1;
      perform public.inventory_accumulate_variant_recipe(
        new.tenant_id, v_venue_id, v_mixer_variant_id,
        v_sold_quantity, 'mixer', v_mixer_product_id
      );
    end if;
  end loop;

  -- Stable modifier semantics: all REMOVE operations precede every ADD.
  delete from pg_temp.inventory_resolved_line resolved
  using public.modifier_inventory_effects effect
  where effect.operation = 'REMOVE'
    and effect.inventory_item_id = resolved.inventory_item_id
    and effect.modifier_id in (
      select modifier_id from pg_temp.inventory_selected_modifier
    );

  for v_modifier_row in
    select effect.*, selected.multiplier, item.base_unit_id
    from pg_temp.inventory_selected_modifier selected
    join public.modifier_inventory_effects effect
      on effect.modifier_id = selected.modifier_id
     and effect.tenant_id = new.tenant_id
     and effect.venue_id = v_venue_id
     and effect.operation = 'ADD'
    join public.inventory_items item
      on item.id = effect.inventory_item_id
     and item.tenant_id = effect.tenant_id
     and item.venue_id = effect.venue_id
    order by effect.sort_order, effect.id
  loop
    insert into pg_temp.inventory_resolved_line (
      inventory_item_id, stock_quantity, sources
    ) values (
      v_modifier_row.inventory_item_id,
      public.inventory_convert_quantity(
        new.tenant_id, v_venue_id,
        v_modifier_row.quantity * v_modifier_row.multiplier,
        v_modifier_row.unit_id, v_modifier_row.base_unit_id
      ),
      jsonb_build_array(jsonb_build_object(
        'type', 'modifier',
        'sourceId', v_modifier_row.modifier_id,
        'recipeQuantity', v_modifier_row.quantity,
        'recipeUnitId', v_modifier_row.unit_id,
        'multiplier', v_modifier_row.multiplier
      ))
    )
    on conflict (inventory_item_id) do update
    set stock_quantity = pg_temp.inventory_resolved_line.stock_quantity + excluded.stock_quantity,
        sources = pg_temp.inventory_resolved_line.sources || excluded.sources;
  end loop;

  for v_resolved in select * from pg_temp.inventory_resolved_line
  loop
    perform public.consume_inventory_item(
      new.tenant_id,
      v_venue_id,
      v_resolved.inventory_item_id,
      v_resolved.stock_quantity,
      new.id,
      case
        when jsonb_array_length(v_resolved.sources) = 1
          then coalesce(v_resolved.sources -> 0 ->> 'type', 'sale')
        else 'sale_aggregate'
      end,
      new.id,
      jsonb_build_object('soldQuantity', v_sold_quantity, 'sources', v_resolved.sources)
    );
  end loop;
  return new;
exception
  when others then
    get stacked diagnostics v_error_code = returned_sqlstate, v_error_message = message_text;
    begin
      insert into public.inventory_consumption_failures (
        tenant_id, venue_id, ticket_line_id, product_id,
        error_code, error_message, details
      ) values (
        new.tenant_id, v_venue_id, new.id, new.product_id,
        coalesce(nullif(v_error_code, ''), 'UNKNOWN'),
        left(coalesce(nullif(v_error_message, ''), 'Unknown inventory error'), 1000),
        jsonb_build_object('variantId', new.variant_id, 'quantity', new.quantity)
      );
    exception when others then null;
    end;
    raise warning 'INVENTORY_CONSUMPTION_FAILED ticket_line=% sqlstate=% error=%',
      new.id, v_error_code, v_error_message;
    return new;
end;
$$;

create trigger consume_ticket_line_inventory
after insert on public.ticket_lines
for each row execute function public.consume_ticket_line_inventory();

create or replace function public.set_inventory_item_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_levels jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_level jsonb;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.inventory_items
    where id = p_inventory_item_id and tenant_id = p_tenant_id and venue_id = p_venue_id
  ) then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode = 'P0002'; end if;
  if jsonb_typeof(coalesce(p_levels, '[]'::jsonb)) <> 'array' then
    raise exception 'INVENTORY_INVALID_LEVELS' using errcode = '22023';
  end if;
  for v_level in select value from jsonb_array_elements(coalesce(p_levels, '[]'::jsonb))
  loop
    insert into public.inventory_stock_levels (
      warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled
    ) values (
      (v_level ->> 'warehouseId')::uuid,
      p_inventory_item_id, p_tenant_id, p_venue_id,
      round((v_level ->> 'quantity')::numeric, 6),
      coalesce((v_level ->> 'enabled')::boolean, true)
    )
    on conflict (warehouse_id, inventory_item_id) do update
    set quantity = excluded.quantity, is_enabled = excluded.is_enabled, updated_at = now();
  end loop;
end;
$$;

create or replace function public.save_inventory_item(
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_name text,
  p_description text,
  p_base_unit_id uuid,
  p_active boolean,
  p_routes jsonb
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_item_id uuid := coalesce(p_inventory_item_id, gen_random_uuid());
  v_route jsonb;
begin
  select tenant_id into v_tenant_id from public.venues where id = p_venue_id;
  if v_tenant_id is null then raise exception 'INVENTORY_VENUE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_tenant_id) then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  if btrim(coalesce(p_name, '')) = '' or char_length(btrim(p_name)) > 120 then
    raise exception 'INVENTORY_INVALID_NAME' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_routes, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_routes, '[]'::jsonb)) = 0
  then raise exception 'INVENTORY_ITEM_ROUTE_REQUIRED' using errcode = '22023'; end if;
  if p_inventory_item_id is not null and exists (
    select 1
    from public.inventory_items item
    join public.inventory_stock_levels level
      on level.inventory_item_id = item.id
     and level.tenant_id = item.tenant_id
     and level.venue_id = item.venue_id
    where item.id = p_inventory_item_id
      and item.tenant_id = v_tenant_id
      and item.venue_id = p_venue_id
      and item.base_unit_id <> p_base_unit_id
      and level.quantity <> 0
  ) then
    raise exception 'INVENTORY_UNIT_CHANGE_WITH_STOCK' using errcode = '22023';
  end if;

  insert into public.inventory_items (
    id, tenant_id, venue_id, name, description, base_unit_id, is_active
  ) values (
    v_item_id, v_tenant_id, p_venue_id, btrim(p_name), btrim(coalesce(p_description, '')),
    p_base_unit_id, coalesce(p_active, true)
  )
  on conflict (id) do update
  set name = excluded.name, description = excluded.description,
      base_unit_id = excluded.base_unit_id, is_active = excluded.is_active,
      updated_at = now()
  where public.inventory_items.tenant_id = v_tenant_id
    and public.inventory_items.venue_id = p_venue_id;

  delete from public.inventory_item_warehouse_routes
  where inventory_item_id = v_item_id;
  for v_route in select value from jsonb_array_elements(p_routes)
  loop
    insert into public.inventory_item_warehouse_routes (
      inventory_item_id, warehouse_id, tenant_id, venue_id, priority, is_enabled
    ) values (
      v_item_id, (v_route ->> 'warehouseId')::uuid, v_tenant_id, p_venue_id,
      (v_route ->> 'priority')::integer,
      coalesce((v_route ->> 'enabled')::boolean, true)
    );
    insert into public.inventory_stock_levels (
      warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled
    ) values (
      (v_route ->> 'warehouseId')::uuid, v_item_id, v_tenant_id, p_venue_id, 0,
      coalesce((v_route ->> 'enabled')::boolean, true)
    ) on conflict (warehouse_id, inventory_item_id) do update
      set is_enabled = excluded.is_enabled;
  end loop;
  return v_item_id;
end;
$$;

create or replace function public.save_variant_inventory_recipe(
  p_variant_id uuid,
  p_mode text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_venue_id uuid;
  v_recipe_id uuid;
  v_line jsonb;
begin
  select tenant_id, venue_id into v_tenant_id, v_venue_id
  from public.product_variants where id = p_variant_id;
  if v_tenant_id is null then raise exception 'CATALOG_VARIANT_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_tenant_id) then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  if p_mode = 'none' then
    delete from public.inventory_recipes where variant_id = p_variant_id;
    return null;
  end if;
  if p_mode not in ('direct', 'recipe') then raise exception 'INVENTORY_INVALID_RECIPE_MODE' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0
    or (p_mode = 'direct' and jsonb_array_length(p_lines) <> 1)
  then raise exception 'INVENTORY_INVALID_RECIPE_LINES' using errcode = '22023'; end if;
  insert into public.inventory_recipes (tenant_id, venue_id, variant_id, mode, is_active)
  values (v_tenant_id, v_venue_id, p_variant_id, p_mode, true)
  on conflict (variant_id) do update set mode = excluded.mode, is_active = true, updated_at = now()
  returning id into v_recipe_id;
  delete from public.inventory_recipe_lines where recipe_id = v_recipe_id;
  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    if not coalesce((v_line ->> 'usesFormatDefault')::boolean, false) then
      perform public.inventory_convert_quantity(
        v_tenant_id, v_venue_id, 1,
        (v_line ->> 'unitId')::uuid,
        (select item.base_unit_id from public.inventory_items item
         where item.id = (v_line ->> 'inventoryItemId')::uuid
           and item.tenant_id = v_tenant_id and item.venue_id = v_venue_id)
      );
    end if;
    insert into public.inventory_recipe_lines (
      recipe_id, tenant_id, venue_id, inventory_item_id,
      quantity, unit_id, uses_format_default, sort_order
    ) values (
      v_recipe_id, v_tenant_id, v_venue_id,
      (v_line ->> 'inventoryItemId')::uuid,
      case when coalesce((v_line ->> 'usesFormatDefault')::boolean, false)
        then null else (v_line ->> 'quantity')::numeric end,
      case when coalesce((v_line ->> 'usesFormatDefault')::boolean, false)
        then null else (v_line ->> 'unitId')::uuid end,
      coalesce((v_line ->> 'usesFormatDefault')::boolean, false),
      coalesce((v_line ->> 'sortOrder')::integer, 0)
    );
  end loop;
  return v_recipe_id;
end;
$$;

create or replace function public.save_modifier_inventory_effects(
  p_modifier_id uuid,
  p_effects jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_venue_id uuid;
  v_effect jsonb;
begin
  select tenant_id, venue_id into v_tenant_id, v_venue_id
  from public.modifiers where id = p_modifier_id;
  if v_tenant_id is null then raise exception 'CATALOG_MODIFIER_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_tenant_id) then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  delete from public.modifier_inventory_effects where modifier_id = p_modifier_id;
  for v_effect in select value from jsonb_array_elements(coalesce(p_effects, '[]'::jsonb))
  loop
    if upper(v_effect ->> 'operation') = 'ADD' then
      perform public.inventory_convert_quantity(
        v_tenant_id, v_venue_id, 1,
        (v_effect ->> 'unitId')::uuid,
        (select item.base_unit_id from public.inventory_items item
         where item.id = (v_effect ->> 'inventoryItemId')::uuid
           and item.tenant_id = v_tenant_id and item.venue_id = v_venue_id)
      );
    end if;
    insert into public.modifier_inventory_effects (
      tenant_id, venue_id, modifier_id, operation, inventory_item_id,
      quantity, unit_id, sort_order
    ) values (
      v_tenant_id, v_venue_id, p_modifier_id, upper(v_effect ->> 'operation'),
      (v_effect ->> 'inventoryItemId')::uuid,
      case when upper(v_effect ->> 'operation') = 'REMOVE' then null else (v_effect ->> 'quantity')::numeric end,
      case when upper(v_effect ->> 'operation') = 'REMOVE' then null else (v_effect ->> 'unitId')::uuid end,
      coalesce((v_effect ->> 'sortOrder')::integer, 0)
    );
  end loop;
end;
$$;

create or replace function public.save_inventory_production_recipe(
  p_inventory_item_id uuid,
  p_production_warehouse_id uuid,
  p_reference_quantity numeric,
  p_reference_unit_id uuid,
  p_active boolean,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_venue_id uuid;
  v_recipe_id uuid;
  v_line jsonb;
begin
  select tenant_id, venue_id into v_tenant_id, v_venue_id
  from public.inventory_items where id = p_inventory_item_id;
  if v_tenant_id is null then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_is_tenant_admin(v_tenant_id) then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0
  then raise exception 'INVENTORY_PRODUCTION_INGREDIENT_REQUIRED' using errcode = '22023'; end if;
  if exists (
    select 1
    from jsonb_array_elements(p_lines) line
    where (line ->> 'inventoryItemId')::uuid = p_inventory_item_id
  ) then raise exception 'INVENTORY_PRODUCTION_SELF_REFERENCE' using errcode = '22023'; end if;
  perform public.inventory_convert_quantity(
    v_tenant_id, v_venue_id, 1, p_reference_unit_id,
    (select item.base_unit_id from public.inventory_items item
     where item.id = p_inventory_item_id)
  );
  insert into public.inventory_production_recipes (
    tenant_id, venue_id, inventory_item_id, production_warehouse_id,
    reference_quantity, reference_unit_id, is_active
  ) values (
    v_tenant_id, v_venue_id, p_inventory_item_id, p_production_warehouse_id,
    p_reference_quantity, p_reference_unit_id, coalesce(p_active, true)
  ) on conflict (inventory_item_id) do update
  set production_warehouse_id = excluded.production_warehouse_id,
      reference_quantity = excluded.reference_quantity,
      reference_unit_id = excluded.reference_unit_id,
      is_active = excluded.is_active,
      updated_at = now()
  returning id into v_recipe_id;
  delete from public.inventory_production_recipe_lines where recipe_id = v_recipe_id;
  for v_line in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    perform public.inventory_convert_quantity(
      v_tenant_id, v_venue_id, 1,
      (v_line ->> 'unitId')::uuid,
      (select item.base_unit_id from public.inventory_items item
       where item.id = (v_line ->> 'inventoryItemId')::uuid
         and item.tenant_id = v_tenant_id and item.venue_id = v_venue_id)
    );
    insert into public.inventory_production_recipe_lines (
      recipe_id, tenant_id, venue_id, inventory_item_id, quantity, unit_id, sort_order
    ) values (
      v_recipe_id, v_tenant_id, v_venue_id,
      (v_line ->> 'inventoryItemId')::uuid,
      (v_line ->> 'quantity')::numeric,
      (v_line ->> 'unitId')::uuid,
      coalesce((v_line ->> 'sortOrder')::integer, 0)
    );
  end loop;
  return v_recipe_id;
end;
$$;

create or replace function public.preview_inventory_production(
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_unit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_recipe record;
  v_factor numeric(18, 9);
  v_stock_quantity numeric(18, 6);
  v_ingredients jsonb;
begin
  select recipe.*, item.name item_name, item.base_unit_id, warehouse.name warehouse_name
  into v_recipe
  from public.inventory_production_recipes recipe
  join public.inventory_items item
    on item.id = recipe.inventory_item_id
   and item.tenant_id = recipe.tenant_id
   and item.venue_id = recipe.venue_id
  join public.inventory_warehouses warehouse
    on warehouse.id = recipe.production_warehouse_id
   and warehouse.tenant_id = recipe.tenant_id
   and warehouse.venue_id = recipe.venue_id
  where recipe.inventory_item_id = p_inventory_item_id and recipe.is_active;
  if v_recipe.id is null then raise exception 'INVENTORY_PRODUCTION_RECIPE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_has_venue_access(v_recipe.tenant_id, v_recipe.venue_id)
    and not public.user_is_tenant_admin(v_recipe.tenant_id)
  then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'INVENTORY_INVALID_QUANTITY' using errcode = '22023'; end if;
  v_factor := public.inventory_convert_quantity(
    v_recipe.tenant_id, v_recipe.venue_id, p_quantity,
    p_unit_id, v_recipe.reference_unit_id
  ) / v_recipe.reference_quantity;
  v_stock_quantity := public.inventory_convert_quantity(
    v_recipe.tenant_id, v_recipe.venue_id, p_quantity,
    p_unit_id, v_recipe.base_unit_id
  );
  select coalesce(jsonb_agg(jsonb_build_object(
    'inventoryItemId', line.inventory_item_id,
    'name', item.name,
    'quantity', round(line.quantity * v_factor, 6),
    'unitId', line.unit_id,
    'unitSymbol', unit.symbol,
    'availableStock', round(public.inventory_convert_quantity(
      v_recipe.tenant_id, v_recipe.venue_id,
      coalesce(stock.quantity, 0), item.base_unit_id, line.unit_id
    ), 6),
    'sufficient', public.inventory_convert_quantity(
      v_recipe.tenant_id, v_recipe.venue_id,
      coalesce(stock.quantity, 0), item.base_unit_id, line.unit_id
    ) >= round(line.quantity * v_factor, 6)
  ) order by line.sort_order, line.id), '[]'::jsonb)
  into v_ingredients
  from public.inventory_production_recipe_lines line
  join public.inventory_items item on item.id = line.inventory_item_id
  join public.inventory_units unit on unit.id = line.unit_id
  left join lateral (
    select sum(level.quantity) quantity
    from public.inventory_stock_levels level
    where level.inventory_item_id = line.inventory_item_id and level.is_enabled
  ) stock on true
  where line.recipe_id = v_recipe.id;
  return jsonb_build_object(
    'inventoryItemId', p_inventory_item_id,
    'name', v_recipe.item_name,
    'quantity', p_quantity,
    'unitId', p_unit_id,
    'stockQuantity', v_stock_quantity,
    'warehouseId', v_recipe.production_warehouse_id,
    'warehouseName', v_recipe.warehouse_name,
    'factor', v_factor,
    'ingredients', v_ingredients
  );
end;
$$;

create or replace function public.list_inventory_preparations(p_venue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_inventory_enabled boolean;
  v_result jsonb;
begin
  select tenant_id, inventory_enabled into v_tenant_id, v_inventory_enabled
  from public.venues where id = p_venue_id;
  if v_tenant_id is null then raise exception 'INVENTORY_VENUE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_has_venue_access(v_tenant_id, p_venue_id)
    and not public.user_is_tenant_admin(v_tenant_id)
  then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  if not v_inventory_enabled then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'inventoryItemId', item.id,
    'name', item.name,
    'availableStock', coalesce(stock.quantity, 0),
    'unitId', item.base_unit_id,
    'unitSymbol', unit.symbol,
    'warehouseId', recipe.production_warehouse_id,
    'warehouseName', warehouse.name,
    'referenceQuantity', recipe.reference_quantity,
    'referenceUnitId', recipe.reference_unit_id,
    'referenceUnitSymbol', reference_unit.symbol
  ) order by item.name), '[]'::jsonb)
  into v_result
  from public.inventory_production_recipes recipe
  join public.inventory_items item
    on item.id = recipe.inventory_item_id
  join public.inventory_units unit on unit.id = item.base_unit_id
  join public.inventory_units reference_unit on reference_unit.id = recipe.reference_unit_id
  join public.inventory_warehouses warehouse on warehouse.id = recipe.production_warehouse_id
  left join lateral (
    select sum(level.quantity) quantity
    from public.inventory_stock_levels level
    where level.inventory_item_id = item.id and level.is_enabled
  ) stock on true
  where recipe.tenant_id = v_tenant_id
    and recipe.venue_id = p_venue_id
    and recipe.is_active and item.is_active;
  return v_result;
end;
$$;

create or replace function public.record_inventory_production(
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_unit_id uuid,
  p_device_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_recipe record;
  v_preview jsonb;
  v_factor numeric(18, 9);
  v_stock_quantity numeric(18, 6);
  v_before numeric(18, 6);
  v_production_id uuid;
  v_line record;
  v_existing_id uuid;
begin
  select recipe.*, item.base_unit_id, venue.inventory_enabled
  into v_recipe
  from public.inventory_production_recipes recipe
  join public.inventory_items item on item.id = recipe.inventory_item_id
  join public.venues venue on venue.id = recipe.venue_id and venue.tenant_id = recipe.tenant_id
  where recipe.inventory_item_id = p_inventory_item_id and recipe.is_active;
  if v_recipe.id is null then raise exception 'INVENTORY_PRODUCTION_RECIPE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not public.user_has_venue_access(v_recipe.tenant_id, v_recipe.venue_id)
    and not public.user_is_tenant_admin(v_recipe.tenant_id)
  then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  if not v_recipe.inventory_enabled then raise exception 'INVENTORY_DISABLED' using errcode = '55000'; end if;

  select id into v_existing_id
  from public.inventory_productions
  where venue_id = v_recipe.venue_id and request_id = p_request_id;
  if v_existing_id is not null then
    return jsonb_build_object('productionId', v_existing_id, 'duplicate', true);
  end if;

  v_preview := public.preview_inventory_production(p_inventory_item_id, p_quantity, p_unit_id);
  v_factor := (v_preview ->> 'factor')::numeric;
  v_stock_quantity := (v_preview ->> 'stockQuantity')::numeric;
  v_production_id := gen_random_uuid();

  insert into public.inventory_productions (
    id, tenant_id, venue_id, inventory_item_id, warehouse_id,
    quantity, unit_id, stock_quantity, recipe_id, recipe_snapshot,
    user_id, device_id, request_id
  ) values (
    v_production_id, v_recipe.tenant_id, v_recipe.venue_id,
    p_inventory_item_id, v_recipe.production_warehouse_id,
    p_quantity, p_unit_id, v_stock_quantity, v_recipe.id, v_preview,
    auth.uid(), p_device_id, p_request_id
  ) on conflict (venue_id, request_id) do nothing
  returning id into v_existing_id;
  if v_existing_id is null then
    select id into v_existing_id
    from public.inventory_productions
    where venue_id = v_recipe.venue_id and request_id = p_request_id;
    return jsonb_build_object('productionId', v_existing_id, 'duplicate', true);
  end if;

  for v_line in
    select line.*, item.base_unit_id
    from public.inventory_production_recipe_lines line
    join public.inventory_items item on item.id = line.inventory_item_id
    where line.recipe_id = v_recipe.id
    order by line.sort_order, line.id
  loop
    perform public.consume_inventory_item(
      v_recipe.tenant_id,
      v_recipe.venue_id,
      v_line.inventory_item_id,
      public.inventory_convert_quantity(
        v_recipe.tenant_id, v_recipe.venue_id,
        v_line.quantity * v_factor, v_line.unit_id, v_line.base_unit_id
      ),
      null,
      'production_ingredient',
      v_recipe.id,
      jsonb_build_object(
        'productionItemId', p_inventory_item_id,
        'recipeQuantity', v_line.quantity * v_factor,
        'recipeUnitId', v_line.unit_id
      ),
      v_production_id
    );
  end loop;

  select quantity into v_before
  from public.inventory_stock_levels
  where warehouse_id = v_recipe.production_warehouse_id
    and inventory_item_id = p_inventory_item_id
  for update;
  v_before := coalesce(v_before, 0);
  insert into public.inventory_stock_levels (
    warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled
  ) values (
    v_recipe.production_warehouse_id, p_inventory_item_id,
    v_recipe.tenant_id, v_recipe.venue_id, v_stock_quantity, true
  ) on conflict (warehouse_id, inventory_item_id) do update
  set quantity = public.inventory_stock_levels.quantity + v_stock_quantity,
      is_enabled = true, updated_at = now();

  insert into public.inventory_stock_movements (
    tenant_id, venue_id, warehouse_id, inventory_item_id,
    source_type, source_id, production_id,
    stock_quantity_delta, stock_quantity_before, stock_quantity_after,
    unit_id, metadata
  ) values (
    v_recipe.tenant_id, v_recipe.venue_id, v_recipe.production_warehouse_id,
    p_inventory_item_id, 'production_output', v_recipe.id, v_production_id,
    v_stock_quantity, v_before, v_before + v_stock_quantity,
    v_recipe.base_unit_id,
    jsonb_build_object('quantity', p_quantity, 'unitId', p_unit_id)
  );
  return jsonb_build_object('productionId', v_production_id, 'duplicate', false, 'preview', v_preview);
end;
$$;

create or replace function public.delete_inventory_warehouse(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_warehouse_id uuid,
  p_target_warehouse_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_moved integer := 0;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501'; end if;
  if p_target_warehouse_id is not null and p_target_warehouse_id = p_warehouse_id then
    raise exception 'INVENTORY_WAREHOUSE_TRANSFER_SAME' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.inventory_stock_levels
    where warehouse_id = p_warehouse_id and quantity <> 0
  ) and p_target_warehouse_id is null then
    raise exception 'INVENTORY_WAREHOUSE_TRANSFER_REQUIRED' using errcode = '22023';
  end if;
  if p_target_warehouse_id is not null then
    insert into public.inventory_stock_levels as destination (
      warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled
    )
    select p_target_warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, true
    from public.inventory_stock_levels
    where warehouse_id = p_warehouse_id
    on conflict (warehouse_id, inventory_item_id) do update
    set quantity = destination.quantity + excluded.quantity, is_enabled = true, updated_at = now();
    get diagnostics v_moved = row_count;
    update public.inventory_production_recipes
    set production_warehouse_id = p_target_warehouse_id, updated_at = now()
    where production_warehouse_id = p_warehouse_id;
  end if;
  delete from public.inventory_warehouses
  where id = p_warehouse_id and tenant_id = p_tenant_id and venue_id = p_venue_id;
  return v_moved;
end;
$$;

-- Shared timestamps.
create trigger set_inventory_items_updated_at before update on public.inventory_items
for each row execute function public.set_updated_at();
create trigger set_inventory_item_routes_updated_at before update on public.inventory_item_warehouse_routes
for each row execute function public.set_updated_at();
create trigger set_inventory_recipes_updated_at before update on public.inventory_recipes
for each row execute function public.set_updated_at();
create trigger set_inventory_recipe_lines_updated_at before update on public.inventory_recipe_lines
for each row execute function public.set_updated_at();
create trigger set_modifier_inventory_effects_updated_at before update on public.modifier_inventory_effects
for each row execute function public.set_updated_at();
create trigger set_inventory_production_recipes_updated_at before update on public.inventory_production_recipes
for each row execute function public.set_updated_at();
create trigger set_inventory_production_recipe_lines_updated_at before update on public.inventory_production_recipe_lines
for each row execute function public.set_updated_at();

alter table public.inventory_items enable row level security;
alter table public.inventory_item_warehouse_routes enable row level security;
alter table public.inventory_recipes enable row level security;
alter table public.inventory_recipe_lines enable row level security;
alter table public.modifier_inventory_effects enable row level security;
alter table public.inventory_production_recipes enable row level security;
alter table public.inventory_production_recipe_lines enable row level security;
alter table public.inventory_productions enable row level security;

create policy inventory_items_read on public.inventory_items for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy inventory_item_routes_read on public.inventory_item_warehouse_routes for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy inventory_recipes_read on public.inventory_recipes for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy inventory_recipe_lines_read on public.inventory_recipe_lines for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy modifier_inventory_effects_read on public.modifier_inventory_effects for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy inventory_production_recipes_read on public.inventory_production_recipes for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy inventory_production_recipe_lines_read on public.inventory_production_recipe_lines for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy inventory_productions_read on public.inventory_productions for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

revoke all on public.inventory_items, public.inventory_item_warehouse_routes,
  public.inventory_recipes, public.inventory_recipe_lines,
  public.modifier_inventory_effects, public.inventory_production_recipes,
  public.inventory_production_recipe_lines, public.inventory_productions
from public, anon;
grant select on public.inventory_items, public.inventory_item_warehouse_routes,
  public.inventory_recipes, public.inventory_recipe_lines,
  public.modifier_inventory_effects, public.inventory_production_recipes,
  public.inventory_production_recipe_lines, public.inventory_productions
to authenticated;

revoke all on function public.consume_inventory_item(uuid, uuid, uuid, numeric, uuid, text, uuid, jsonb, uuid)
  from public, anon, authenticated;
revoke all on function public.inventory_accumulate_variant_recipe(uuid, uuid, uuid, numeric, text, uuid)
  from public, anon, authenticated;
revoke all on function public.consume_ticket_line_inventory()
  from public, anon, authenticated;
revoke all on function public.prevent_inventory_unit_equivalence_change_with_stock(),
  public.inventory_units_compatible(uuid, uuid, uuid, uuid),
  public.inventory_convert_quantity(uuid, uuid, numeric, uuid, uuid)
from public, anon, authenticated;

revoke all on function public.set_inventory_item_stock(uuid, uuid, uuid, jsonb),
  public.save_inventory_item(uuid, uuid, text, text, uuid, boolean, jsonb),
  public.save_variant_inventory_recipe(uuid, text, jsonb),
  public.save_modifier_inventory_effects(uuid, jsonb),
  public.save_inventory_production_recipe(uuid, uuid, numeric, uuid, boolean, jsonb),
  public.preview_inventory_production(uuid, numeric, uuid),
  public.list_inventory_preparations(uuid),
  public.record_inventory_production(uuid, numeric, uuid, uuid, uuid),
  public.delete_inventory_warehouse(uuid, uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function public.set_inventory_item_stock(uuid, uuid, uuid, jsonb),
  public.save_inventory_item(uuid, uuid, text, text, uuid, boolean, jsonb),
  public.save_variant_inventory_recipe(uuid, text, jsonb),
  public.save_modifier_inventory_effects(uuid, jsonb),
  public.save_inventory_production_recipe(uuid, uuid, numeric, uuid, boolean, jsonb),
  public.preview_inventory_production(uuid, numeric, uuid),
  public.list_inventory_preparations(uuid),
  public.record_inventory_production(uuid, numeric, uuid, uuid, uuid),
  public.delete_inventory_warehouse(uuid, uuid, uuid, uuid)
to authenticated;

comment on table public.inventory_items is
  'Physical venue-scoped stock identities, independent from sellable catalog products.';
comment on table public.inventory_recipes is
  'Single inventory-consumption route for direct products and composite variant recipes.';
comment on column public.inventory_recipe_lines.uses_format_default is
  'When true, quantity and unit are resolved live from the variant sale format.';
comment on table public.inventory_productions is
  'Explicit preparation events. Recipes never auto-produce during a sale.';
comment on function public.consume_ticket_line_inventory() is
  'Resolves base variants, real menu components and modifier REMOVE/ADD effects atomically; failures never reject the sale.';
