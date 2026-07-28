-- Inventory foundation: venue-scoped units, warehouses and product stock.
-- Automatic stock consumption is intentionally deferred until product recipes
-- (for example 70 ml of rum plus one mixer bottle) are configured.

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname = 'products_inventory_scope_unique'
  ) then
    alter table public.products
      add constraint products_inventory_scope_unique
      unique (id, tenant_id, venue_id);
  end if;
end;
$$;

create table if not exists public.inventory_units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  symbol text not null,
  decimal_places smallint not null default 0,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_units_name_check
    check (btrim(name) <> '' and char_length(name) <= 80),
  constraint inventory_units_symbol_check
    check (btrim(symbol) <> '' and char_length(symbol) <= 12),
  constraint inventory_units_decimal_places_check
    check (decimal_places between 0 and 6),
  constraint inventory_units_sort_order_check
    check (sort_order >= 0),
  constraint inventory_units_scope_unique
    unique (id, tenant_id, venue_id)
);

create unique index if not exists inventory_units_venue_name_unique
  on public.inventory_units (tenant_id, venue_id, lower(name));

create table if not exists public.inventory_warehouses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  description text not null default '',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_warehouses_name_check
    check (btrim(name) <> '' and char_length(name) <= 80),
  constraint inventory_warehouses_description_check
    check (char_length(description) <= 240),
  constraint inventory_warehouses_sort_order_check
    check (sort_order >= 0),
  constraint inventory_warehouses_scope_unique
    unique (id, tenant_id, venue_id)
);

create unique index if not exists inventory_warehouses_venue_name_unique
  on public.inventory_warehouses (tenant_id, venue_id, lower(name));

create table if not exists public.inventory_product_settings (
  product_id uuid primary key,
  tenant_id uuid not null,
  venue_id uuid not null,
  unit_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_product_settings_scope_unique
    unique (product_id, tenant_id, venue_id),
  constraint inventory_product_settings_product_scope_fk
    foreign key (product_id, tenant_id, venue_id)
    references public.products(id, tenant_id, venue_id)
    on delete cascade,
  constraint inventory_product_settings_unit_scope_fk
    foreign key (unit_id, tenant_id, venue_id)
    references public.inventory_units(id, tenant_id, venue_id)
);

create table if not exists public.inventory_stock_levels (
  warehouse_id uuid not null,
  product_id uuid not null,
  tenant_id uuid not null,
  venue_id uuid not null,
  quantity numeric(18, 6) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (warehouse_id, product_id),
  constraint inventory_stock_levels_quantity_check
    check (quantity >= 0),
  constraint inventory_stock_levels_warehouse_scope_fk
    foreign key (warehouse_id, tenant_id, venue_id)
    references public.inventory_warehouses(id, tenant_id, venue_id)
    on delete cascade,
  constraint inventory_stock_levels_product_scope_fk
    foreign key (product_id, tenant_id, venue_id)
    references public.inventory_product_settings(product_id, tenant_id, venue_id)
    on delete cascade
);

create index if not exists inventory_units_venue_idx
  on public.inventory_units (tenant_id, venue_id, is_active, sort_order);

create index if not exists inventory_warehouses_venue_idx
  on public.inventory_warehouses (tenant_id, venue_id, is_active, sort_order);

create index if not exists inventory_product_settings_venue_idx
  on public.inventory_product_settings (tenant_id, venue_id);

create index if not exists inventory_stock_levels_product_idx
  on public.inventory_stock_levels (tenant_id, venue_id, product_id);

drop trigger if exists set_inventory_units_updated_at on public.inventory_units;
create trigger set_inventory_units_updated_at
before update on public.inventory_units
for each row execute function public.set_updated_at();

drop trigger if exists set_inventory_warehouses_updated_at on public.inventory_warehouses;
create trigger set_inventory_warehouses_updated_at
before update on public.inventory_warehouses
for each row execute function public.set_updated_at();

drop trigger if exists set_inventory_product_settings_updated_at on public.inventory_product_settings;
create trigger set_inventory_product_settings_updated_at
before update on public.inventory_product_settings
for each row execute function public.set_updated_at();

drop trigger if exists set_inventory_stock_levels_updated_at on public.inventory_stock_levels;
create trigger set_inventory_stock_levels_updated_at
before update on public.inventory_stock_levels
for each row execute function public.set_updated_at();

create or replace function public.set_inventory_product_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_product_id uuid,
  p_unit_id uuid,
  p_levels jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_levels jsonb := coalesce(p_levels, '[]'::jsonb);
  v_decimal_places integer;
  v_current_unit_id uuid;
  v_level jsonb;
  v_level_count integer;
  v_valid_warehouse_count integer;
  v_quantity numeric(18, 6);
  v_warehouse_id uuid;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.venues v
    where v.id = p_venue_id
      and v.tenant_id = p_tenant_id
  ) then
    raise exception 'INVENTORY_VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from public.products p
    where p.id = p_product_id
      and p.tenant_id = p_tenant_id
      and p.venue_id = p_venue_id
  ) then
    raise exception 'INVENTORY_PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select u.decimal_places
  into v_decimal_places
  from public.inventory_units u
  where u.id = p_unit_id
    and u.tenant_id = p_tenant_id
    and u.venue_id = p_venue_id
    and u.is_active = true;

  if v_decimal_places is null then
    raise exception 'INVENTORY_UNIT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if jsonb_typeof(v_levels) <> 'array' then
    raise exception 'INVENTORY_INVALID_LEVELS' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_levels) item
    where jsonb_typeof(item) <> 'object'
      or nullif(btrim(item ->> 'warehouseId'), '') is null
      or (item ->> 'warehouseId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(item -> 'quantity') <> 'number'
  ) then
    raise exception 'INVENTORY_INVALID_LEVELS' using errcode = '22023';
  end if;

  select count(*)
  into v_level_count
  from jsonb_array_elements(v_levels);

  if (
    select count(distinct item ->> 'warehouseId')
    from jsonb_array_elements(v_levels) item
  ) <> v_level_count then
    raise exception 'INVENTORY_DUPLICATE_WAREHOUSE' using errcode = '22023';
  end if;

  select count(*)
  into v_valid_warehouse_count
  from public.inventory_warehouses w
  where w.tenant_id = p_tenant_id
    and w.venue_id = p_venue_id
    and w.is_active = true
    and w.id in (
      select (item ->> 'warehouseId')::uuid
      from jsonb_array_elements(v_levels) item
    );

  if v_valid_warehouse_count <> v_level_count then
    raise exception 'INVENTORY_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_levels) item
    where (item ->> 'quantity')::numeric < 0
      or round((item ->> 'quantity')::numeric, 6)
        <> (item ->> 'quantity')::numeric
      or (item ->> 'quantity')::numeric > 999999999999.999999
  ) then
    raise exception 'INVENTORY_INVALID_QUANTITY' using errcode = '22023';
  end if;

  select s.unit_id
  into v_current_unit_id
  from public.inventory_product_settings s
  where s.product_id = p_product_id
    and s.tenant_id = p_tenant_id
    and s.venue_id = p_venue_id;

  if v_current_unit_id is distinct from p_unit_id
    and v_current_unit_id is not null
    and exists (
      select 1
      from public.inventory_stock_levels l
      where l.product_id = p_product_id
        and l.tenant_id = p_tenant_id
        and l.venue_id = p_venue_id
        and l.quantity <> 0
    )
  then
    raise exception 'INVENTORY_UNIT_CHANGE_WITH_STOCK' using errcode = '22023';
  end if;

  insert into public.inventory_product_settings (
    product_id,
    tenant_id,
    venue_id,
    unit_id
  )
  values (
    p_product_id,
    p_tenant_id,
    p_venue_id,
    p_unit_id
  )
  on conflict (product_id) do update
  set unit_id = excluded.unit_id,
      updated_at = now();

  for v_level in
    select item
    from jsonb_array_elements(v_levels) item
  loop
    v_warehouse_id := (v_level ->> 'warehouseId')::uuid;
    v_quantity := (v_level ->> 'quantity')::numeric(18, 6);

    insert into public.inventory_stock_levels (
      warehouse_id,
      product_id,
      tenant_id,
      venue_id,
      quantity
    )
    values (
      v_warehouse_id,
      p_product_id,
      p_tenant_id,
      p_venue_id,
      v_quantity
    )
    on conflict (warehouse_id, product_id) do update
    set quantity = excluded.quantity,
        updated_at = now();
  end loop;
end;
$$;

alter table public.inventory_units enable row level security;
alter table public.inventory_warehouses enable row level security;
alter table public.inventory_product_settings enable row level security;
alter table public.inventory_stock_levels enable row level security;

drop policy if exists inventory_units_select on public.inventory_units;
create policy inventory_units_select
on public.inventory_units
for select
to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

drop policy if exists inventory_units_manage on public.inventory_units;
create policy inventory_units_manage
on public.inventory_units
for all
to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (
  public.user_is_tenant_admin(tenant_id)
  and exists (
    select 1
    from public.venues v
    where v.id = inventory_units.venue_id
      and v.tenant_id = inventory_units.tenant_id
  )
);

drop policy if exists inventory_warehouses_select on public.inventory_warehouses;
create policy inventory_warehouses_select
on public.inventory_warehouses
for select
to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

drop policy if exists inventory_warehouses_manage on public.inventory_warehouses;
create policy inventory_warehouses_manage
on public.inventory_warehouses
for all
to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (
  public.user_is_tenant_admin(tenant_id)
  and exists (
    select 1
    from public.venues v
    where v.id = inventory_warehouses.venue_id
      and v.tenant_id = inventory_warehouses.tenant_id
  )
);

drop policy if exists inventory_product_settings_select on public.inventory_product_settings;
create policy inventory_product_settings_select
on public.inventory_product_settings
for select
to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

drop policy if exists inventory_stock_levels_select on public.inventory_stock_levels;
create policy inventory_stock_levels_select
on public.inventory_stock_levels
for select
to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

revoke all on table public.inventory_units from public, anon;
revoke all on table public.inventory_warehouses from public, anon;
revoke all on table public.inventory_product_settings from public, anon;
revoke all on table public.inventory_stock_levels from public, anon;

grant select, insert, update, delete
  on table public.inventory_units to authenticated;
grant select, insert, update, delete
  on table public.inventory_warehouses to authenticated;
grant select on table public.inventory_product_settings to authenticated;
grant select on table public.inventory_stock_levels to authenticated;

revoke all on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  jsonb
) from public, anon;
grant execute on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  jsonb
) to authenticated;

comment on table public.inventory_units is
  'Venue-scoped measurement units used as each product inventory base unit.';
comment on table public.inventory_warehouses is
  'Venue-scoped physical stock locations.';
comment on table public.inventory_product_settings is
  'Base inventory unit selected for each product.';
comment on table public.inventory_stock_levels is
  'Current product quantity per warehouse, stored with fractional precision.';
comment on function public.set_inventory_product_stock(uuid, uuid, uuid, uuid, jsonb) is
  'Atomically assigns a product base unit and saves its venue-scoped warehouse quantities.';
