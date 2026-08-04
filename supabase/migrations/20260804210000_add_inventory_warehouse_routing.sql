-- Configure which products belong to each warehouse and which warehouses each
-- POS device may consume from. Device priority uses the lowest number first.

alter table public.inventory_stock_levels
  add column if not exists is_enabled boolean not null default true;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.devices'::regclass
      and conname = 'devices_inventory_scope_unique'
  ) then
    alter table public.devices
      add constraint devices_inventory_scope_unique
      unique (id, tenant_id, venue_id);
  end if;
end;
$$;

create table if not exists public.inventory_device_warehouses (
  device_id uuid not null,
  warehouse_id uuid not null,
  tenant_id uuid not null,
  venue_id uuid not null,
  is_enabled boolean not null default true,
  priority integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (device_id, warehouse_id),
  constraint inventory_device_warehouses_priority_check
    check (priority between 1 and 9999),
  constraint inventory_device_warehouses_device_scope_fk
    foreign key (device_id, tenant_id, venue_id)
    references public.devices(id, tenant_id, venue_id)
    on delete cascade,
  constraint inventory_device_warehouses_warehouse_scope_fk
    foreign key (warehouse_id, tenant_id, venue_id)
    references public.inventory_warehouses(id, tenant_id, venue_id)
    on delete cascade
);

create index if not exists inventory_device_warehouses_venue_idx
  on public.inventory_device_warehouses
  (tenant_id, venue_id, device_id, is_enabled, priority);

drop trigger if exists set_inventory_device_warehouses_updated_at
  on public.inventory_device_warehouses;
create trigger set_inventory_device_warehouses_updated_at
before update on public.inventory_device_warehouses
for each row execute function public.set_updated_at();

alter table public.inventory_device_warehouses enable row level security;

drop policy if exists inventory_device_warehouses_select
  on public.inventory_device_warehouses;
create policy inventory_device_warehouses_select
on public.inventory_device_warehouses
for select
to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

revoke all on table public.inventory_device_warehouses from public, anon;
grant select on table public.inventory_device_warehouses to authenticated;

create or replace function public.set_inventory_device_warehouses(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_device_id uuid,
  p_assignments jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_assignments jsonb := coalesce(p_assignments, '[]'::jsonb);
  v_assignment jsonb;
  v_assignment_count integer;
  v_valid_warehouse_count integer;
  v_warehouse_id uuid;
  v_enabled boolean;
  v_priority integer;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.devices d
    where d.id = p_device_id
      and d.tenant_id = p_tenant_id
      and d.venue_id = p_venue_id
  ) then
    raise exception 'INVENTORY_DEVICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if jsonb_typeof(v_assignments) <> 'array' then
    raise exception 'INVENTORY_INVALID_DEVICE_WAREHOUSES' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_assignments) item
    where jsonb_typeof(item) <> 'object'
      or nullif(btrim(item ->> 'warehouseId'), '') is null
      or (item ->> 'warehouseId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(jsonb_typeof(item -> 'enabled'), 'null') <> 'boolean'
      or coalesce(jsonb_typeof(item -> 'priority'), 'null') <> 'number'
      or (item ->> 'priority')::numeric <> trunc((item ->> 'priority')::numeric)
      or (item ->> 'priority')::numeric not between 1 and 9999
  ) then
    raise exception 'INVENTORY_INVALID_DEVICE_WAREHOUSES' using errcode = '22023';
  end if;

  select count(*) into v_assignment_count
  from jsonb_array_elements(v_assignments);

  if (
    select count(distinct item ->> 'warehouseId')
    from jsonb_array_elements(v_assignments) item
  ) <> v_assignment_count then
    raise exception 'INVENTORY_DUPLICATE_WAREHOUSE' using errcode = '22023';
  end if;

  if (
    select count(distinct (item ->> 'priority')::integer)
    from jsonb_array_elements(v_assignments) item
    where (item ->> 'enabled')::boolean
  ) <> (
    select count(*)
    from jsonb_array_elements(v_assignments) item
    where (item ->> 'enabled')::boolean
  ) then
    raise exception 'INVENTORY_DUPLICATE_PRIORITY' using errcode = '22023';
  end if;

  select count(*) into v_valid_warehouse_count
  from public.inventory_warehouses w
  where w.tenant_id = p_tenant_id
    and w.venue_id = p_venue_id
    and w.id in (
      select (item ->> 'warehouseId')::uuid
      from jsonb_array_elements(v_assignments) item
    );

  if v_valid_warehouse_count <> v_assignment_count then
    raise exception 'INVENTORY_WAREHOUSE_NOT_FOUND' using errcode = 'P0002';
  end if;

  for v_assignment in
    select item from jsonb_array_elements(v_assignments) item
  loop
    v_warehouse_id := (v_assignment ->> 'warehouseId')::uuid;
    v_enabled := (v_assignment ->> 'enabled')::boolean;
    v_priority := (v_assignment ->> 'priority')::integer;

    insert into public.inventory_device_warehouses (
      device_id,
      warehouse_id,
      tenant_id,
      venue_id,
      is_enabled,
      priority
    )
    values (
      p_device_id,
      v_warehouse_id,
      p_tenant_id,
      p_venue_id,
      v_enabled,
      v_priority
    )
    on conflict (device_id, warehouse_id) do update
    set is_enabled = excluded.is_enabled,
        priority = excluded.priority,
        updated_at = now();
  end loop;

  delete from public.inventory_device_warehouses dw
  where dw.device_id = p_device_id
    and dw.tenant_id = p_tenant_id
    and dw.venue_id = p_venue_id
    and not exists (
      select 1
      from jsonb_array_elements(v_assignments) item
      where (item ->> 'warehouseId')::uuid = dw.warehouse_id
    );
end;
$$;

revoke all on function public.set_inventory_device_warehouses(
  uuid,
  uuid,
  uuid,
  jsonb
) from public, anon;
grant execute on function public.set_inventory_device_warehouses(
  uuid,
  uuid,
  uuid,
  jsonb
) to authenticated;

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
  v_content_quantity numeric(18, 6);
  v_content_unit_id uuid;
  v_current_unit_id uuid;
  v_level jsonb;
  v_level_count integer;
  v_valid_warehouse_count integer;
  v_quantity numeric(18, 6);
  v_warehouse_id uuid;
  v_enabled boolean;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.venues v
    where v.id = p_venue_id and v.tenant_id = p_tenant_id
  ) then
    raise exception 'INVENTORY_VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.products p
    where p.id = p_product_id
      and p.tenant_id = p_tenant_id
      and p.venue_id = p_venue_id
  ) then
    raise exception 'INVENTORY_PRODUCT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select u.content_quantity, u.content_unit_id
  into v_content_quantity, v_content_unit_id
  from public.inventory_units u
  where u.id = p_unit_id
    and u.tenant_id = p_tenant_id
    and u.venue_id = p_venue_id
    and u.is_active = true;

  if v_content_unit_id is null then
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
      or (item ? 'enabled' and jsonb_typeof(item -> 'enabled') <> 'boolean')
  ) then
    raise exception 'INVENTORY_INVALID_LEVELS' using errcode = '22023';
  end if;

  select count(*) into v_level_count
  from jsonb_array_elements(v_levels);

  if (
    select count(distinct item ->> 'warehouseId')
    from jsonb_array_elements(v_levels) item
  ) <> v_level_count then
    raise exception 'INVENTORY_DUPLICATE_WAREHOUSE' using errcode = '22023';
  end if;

  select count(*) into v_valid_warehouse_count
  from public.inventory_warehouses w
  where w.tenant_id = p_tenant_id
    and w.venue_id = p_venue_id
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
      or round((item ->> 'quantity')::numeric, 6) <> (item ->> 'quantity')::numeric
      or (item ->> 'quantity')::numeric > 999999999999.999999
  ) then
    raise exception 'INVENTORY_INVALID_QUANTITY' using errcode = '22023';
  end if;

  select s.unit_id into v_current_unit_id
  from public.inventory_product_settings s
  where s.product_id = p_product_id
    and s.tenant_id = p_tenant_id
    and s.venue_id = p_venue_id;

  if v_current_unit_id is not null
    and v_current_unit_id is distinct from p_unit_id
    and exists (
      select 1
      from public.inventory_stock_levels l
      where l.product_id = p_product_id
        and l.tenant_id = p_tenant_id
        and l.venue_id = p_venue_id
        and l.quantity <> 0
    )
  then
    raise exception 'INVENTORY_PACKAGE_CHANGE_WITH_STOCK' using errcode = '22023';
  end if;

  insert into public.inventory_product_settings (
    product_id,
    tenant_id,
    venue_id,
    unit_id,
    content_quantity,
    content_unit_id
  )
  values (
    p_product_id,
    p_tenant_id,
    p_venue_id,
    p_unit_id,
    v_content_quantity,
    v_content_unit_id
  )
  on conflict (product_id) do update
  set unit_id = excluded.unit_id,
      content_quantity = excluded.content_quantity,
      content_unit_id = excluded.content_unit_id,
      updated_at = now();

  for v_level in
    select item from jsonb_array_elements(v_levels) item
  loop
    v_warehouse_id := (v_level ->> 'warehouseId')::uuid;
    v_quantity := (v_level ->> 'quantity')::numeric(18, 6);
    v_enabled := coalesce((v_level ->> 'enabled')::boolean, true);

    insert into public.inventory_stock_levels (
      warehouse_id,
      product_id,
      tenant_id,
      venue_id,
      quantity,
      is_enabled
    )
    values (
      v_warehouse_id,
      p_product_id,
      p_tenant_id,
      p_venue_id,
      v_quantity,
      v_enabled
    )
    on conflict (warehouse_id, product_id) do update
    set quantity = excluded.quantity,
        is_enabled = excluded.is_enabled,
        updated_at = now();
  end loop;

  delete from public.inventory_product_format_consumptions
  where product_id = p_product_id
    and tenant_id = p_tenant_id
    and venue_id = p_venue_id;
end;
$$;

create or replace function public.consume_inventory_product(
  p_ticket_line_id uuid,
  p_tenant_id uuid,
  p_venue_id uuid,
  p_device_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_sold_quantity numeric,
  p_source_type text
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_variant_id uuid := p_variant_id;
  v_sale_format_id uuid;
  v_format_quantity numeric(18, 6);
  v_format_unit_id uuid;
  v_stock_unit_id uuid;
  v_content_quantity numeric(18, 6);
  v_content_unit_id uuid;
  v_required_stock numeric(18, 6);
  v_remaining numeric(18, 6);
  v_take numeric(18, 6);
  v_stock record;
  v_has_device_config boolean := false;
  v_overflow_warehouse_id uuid;
  v_overflow_quantity numeric(18, 6);
begin
  if p_product_id is null
    or coalesce(p_sold_quantity, 0) <= 0
    or p_source_type not in ('product', 'mixer', 'menu_component')
  then
    return;
  end if;

  if v_variant_id is null then
    select pv.id into v_variant_id
    from public.product_variants pv
    where pv.product_id = p_product_id
      and pv.tenant_id = p_tenant_id
      and pv.venue_id = p_venue_id
      and pv.is_active = true
    order by pv.is_default desc, pv.sort_order, pv.id
    limit 1;
  end if;

  select
    pv.catalog_sale_format_id,
    f.inventory_consumption_quantity,
    f.inventory_consumption_unit_id
  into
    v_sale_format_id,
    v_format_quantity,
    v_format_unit_id
  from public.product_variants pv
  join public.catalog_sale_formats f
    on f.id = pv.catalog_sale_format_id
   and f.tenant_id = pv.tenant_id
   and f.venue_id = pv.venue_id
  where pv.id = v_variant_id
    and pv.product_id = p_product_id
    and pv.tenant_id = p_tenant_id
    and pv.venue_id = p_venue_id;

  if v_format_quantity is null or v_format_unit_id is null then return; end if;

  select s.unit_id, u.content_quantity, u.content_unit_id
  into v_stock_unit_id, v_content_quantity, v_content_unit_id
  from public.inventory_product_settings s
  join public.inventory_units u
    on u.id = s.unit_id
   and u.tenant_id = s.tenant_id
   and u.venue_id = s.venue_id
  where s.product_id = p_product_id
    and s.tenant_id = p_tenant_id
    and s.venue_id = p_venue_id;

  if v_stock_unit_id is null then return; end if;

  if v_content_unit_id <> v_format_unit_id then
    raise exception 'INVENTORY_CONSUMPTION_UNIT_MISMATCH product=% format=%',
      p_product_id,
      v_sale_format_id
      using errcode = '22023';
  end if;

  v_required_stock := round(
    (v_format_quantity * p_sold_quantity) / v_content_quantity,
    6
  );
  if v_required_stock <= 0 then return; end if;
  v_remaining := v_required_stock;

  if p_device_id is not null then
    select exists (
      select 1
      from public.inventory_device_warehouses dw
      where dw.device_id = p_device_id
        and dw.tenant_id = p_tenant_id
        and dw.venue_id = p_venue_id
    ) into v_has_device_config;
  end if;

  for v_stock in
    select l.warehouse_id, l.quantity, w.sort_order, w.name
    from public.inventory_stock_levels l
    join public.inventory_warehouses w
      on w.id = l.warehouse_id
     and w.tenant_id = l.tenant_id
     and w.venue_id = l.venue_id
    left join public.inventory_device_warehouses dw
      on dw.device_id = p_device_id
     and dw.warehouse_id = l.warehouse_id
     and dw.tenant_id = l.tenant_id
     and dw.venue_id = l.venue_id
    where l.product_id = p_product_id
      and l.tenant_id = p_tenant_id
      and l.venue_id = p_venue_id
      and l.is_enabled = true
      and l.quantity > 0
      and w.is_active = true
      and (not v_has_device_config or coalesce(dw.is_enabled, false))
    order by
      case when v_has_device_config then dw.priority else w.sort_order end,
      w.sort_order,
      w.name,
      w.id
    for update of l
  loop
    v_take := least(v_remaining, v_stock.quantity);

    update public.inventory_stock_levels
    set quantity = quantity - v_take,
        updated_at = now()
    where warehouse_id = v_stock.warehouse_id
      and product_id = p_product_id;

    insert into public.inventory_stock_movements (
      tenant_id,
      venue_id,
      warehouse_id,
      product_id,
      ticket_line_id,
      sale_format_id,
      source_type,
      stock_quantity_delta,
      stock_quantity_before,
      stock_quantity_after,
      format_consumption_quantity,
      sold_quantity,
      content_unit_id
    )
    values (
      p_tenant_id,
      p_venue_id,
      v_stock.warehouse_id,
      p_product_id,
      p_ticket_line_id,
      v_sale_format_id,
      p_source_type,
      -v_take,
      v_stock.quantity,
      v_stock.quantity - v_take,
      v_format_quantity,
      p_sold_quantity,
      v_content_unit_id
    );

    v_remaining := round(v_remaining - v_take, 6);
    exit when v_remaining <= 0;
  end loop;

  if v_remaining <= 0 then return; end if;

  select l.warehouse_id, l.quantity
  into v_overflow_warehouse_id, v_overflow_quantity
  from public.inventory_stock_levels l
  join public.inventory_warehouses w
    on w.id = l.warehouse_id
   and w.tenant_id = l.tenant_id
   and w.venue_id = l.venue_id
  left join public.inventory_device_warehouses dw
    on dw.device_id = p_device_id
   and dw.warehouse_id = l.warehouse_id
   and dw.tenant_id = l.tenant_id
   and dw.venue_id = l.venue_id
  where l.product_id = p_product_id
    and l.tenant_id = p_tenant_id
    and l.venue_id = p_venue_id
    and l.is_enabled = true
    and w.is_active = true
    and (not v_has_device_config or coalesce(dw.is_enabled, false))
  order by
    case when v_has_device_config then dw.priority else w.sort_order end,
    w.sort_order,
    w.name,
    w.id
  limit 1
  for update of l;

  if v_overflow_warehouse_id is null then return; end if;

  update public.inventory_stock_levels
  set quantity = quantity - v_remaining,
      updated_at = now()
  where warehouse_id = v_overflow_warehouse_id
    and product_id = p_product_id;

  insert into public.inventory_stock_movements (
    tenant_id,
    venue_id,
    warehouse_id,
    product_id,
    ticket_line_id,
    sale_format_id,
    source_type,
    stock_quantity_delta,
    stock_quantity_before,
    stock_quantity_after,
    format_consumption_quantity,
    sold_quantity,
    content_unit_id
  )
  values (
    p_tenant_id,
    p_venue_id,
    v_overflow_warehouse_id,
    p_product_id,
    p_ticket_line_id,
    v_sale_format_id,
    p_source_type,
    -v_remaining,
    v_overflow_quantity,
    v_overflow_quantity - v_remaining,
    v_format_quantity,
    p_sold_quantity,
    v_content_unit_id
  );
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
  v_device_id uuid;
  v_sold_quantity numeric(18, 9);
  v_component record;
  v_modifier jsonb;
  v_mixer_product_id uuid;
  v_mixer_variant_id uuid;
begin
  select t.venue_id, t.device_id
  into v_venue_id, v_device_id
  from public.tickets t
  where t.id = new.ticket_id
    and t.tenant_id = new.tenant_id;

  if v_venue_id is null then
    raise exception 'INVENTORY_TICKET_SCOPE_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_sold_quantity := coalesce(new.allocated_quantity, new.quantity::numeric);

  perform public.consume_inventory_product(
    new.id,
    new.tenant_id,
    v_venue_id,
    v_device_id,
    new.product_id,
    new.variant_id,
    v_sold_quantity,
    'product'
  );

  for v_component in
    select c.component_type, c.product_id, c.variant_id, c.quantity
    from public.ticket_line_components c
    where c.ticket_line_id = new.id
      and c.tenant_id = new.tenant_id
      and c.product_id is not null
  loop
    perform public.consume_inventory_product(
      new.id,
      new.tenant_id,
      v_venue_id,
      v_device_id,
      v_component.product_id,
      v_component.variant_id,
      v_sold_quantity * v_component.quantity,
      case
        when v_component.component_type = 'mixer' then 'mixer'
        else 'menu_component'
      end
    );
  end loop;

  if not exists (
    select 1
    from public.ticket_line_components c
    where c.ticket_line_id = new.id
      and c.component_type = 'mixer'
  ) then
    for v_modifier in
      select value
      from jsonb_array_elements(coalesce(new.modifiers, '[]'::jsonb))
      where value ->> 'id' ~* '^mixer:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    loop
      v_mixer_product_id := substring(v_modifier ->> 'id' from 7)::uuid;
      select pv.id into v_mixer_variant_id
      from public.product_variants pv
      where pv.product_id = v_mixer_product_id
        and pv.tenant_id = new.tenant_id
        and pv.venue_id = v_venue_id
        and pv.is_active = true
      order by pv.is_default desc, pv.sort_order, pv.id
      limit 1;

      perform public.consume_inventory_product(
        new.id,
        new.tenant_id,
        v_venue_id,
        v_device_id,
        v_mixer_product_id,
        v_mixer_variant_id,
        v_sold_quantity,
        'mixer'
      );
    end loop;
  end if;

  return new;
end;
$$;

drop function if exists public.consume_inventory_product(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  text
);

revoke all on function public.consume_inventory_product(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  text
) from public, anon, authenticated;

comment on column public.inventory_stock_levels.is_enabled is
  'Whether this product is stocked and may be consumed from this warehouse.';
comment on table public.inventory_device_warehouses is
  'Warehouse access and stock consumption priority configured per POS device.';
comment on function public.set_inventory_device_warehouses(uuid, uuid, uuid, jsonb) is
  'Atomically replaces warehouse access and consumption priority for one POS device.';
