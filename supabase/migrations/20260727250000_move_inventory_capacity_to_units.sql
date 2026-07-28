-- Inventory package capacity belongs to the reusable inventory unit.
-- Example: "Botella 70 cl" contains 700 "ml". Products only select a unit.

alter table public.inventory_units
  add column if not exists content_quantity numeric(18, 6),
  add column if not exists content_unit_id uuid;

-- Preserve existing product-specific definitions. If an old stock unit was
-- used with more than one capacity, create one reusable unit per capacity.
do $$
declare
  v_definition record;
  v_new_unit_id uuid;
  v_new_name text;
begin
  for v_definition in
    select
      definitions.*,
      row_number() over (
        partition by definitions.unit_id
        order by definitions.content_unit_id::text, definitions.content_quantity
      ) as definition_number
    from (
      select distinct
        s.unit_id,
        s.tenant_id,
        s.venue_id,
        s.content_quantity,
        s.content_unit_id
      from public.inventory_product_settings s
    ) definitions
  loop
    if v_definition.definition_number = 1 then
      update public.inventory_units
      set content_quantity = v_definition.content_quantity,
          content_unit_id = v_definition.content_unit_id
      where id = v_definition.unit_id
        and tenant_id = v_definition.tenant_id
        and venue_id = v_definition.venue_id;
    else
      v_new_unit_id := gen_random_uuid();

      select left(
        u.name || ' · ' || trim(to_char(v_definition.content_quantity, 'FM999999999999990.######'))
          || ' ' || coalesce(content_unit.symbol, '') || ' [' || left(v_new_unit_id::text, 8) || ']',
        80
      )
      into v_new_name
      from public.inventory_units u
      left join public.inventory_units content_unit
        on content_unit.id = v_definition.content_unit_id
       and content_unit.tenant_id = v_definition.tenant_id
       and content_unit.venue_id = v_definition.venue_id
      where u.id = v_definition.unit_id
        and u.tenant_id = v_definition.tenant_id
        and u.venue_id = v_definition.venue_id;

      insert into public.inventory_units (
        id,
        tenant_id,
        venue_id,
        name,
        symbol,
        decimal_places,
        content_quantity,
        content_unit_id,
        is_active,
        sort_order
      )
      select
        v_new_unit_id,
        u.tenant_id,
        u.venue_id,
        v_new_name,
        u.symbol,
        u.decimal_places,
        v_definition.content_quantity,
        case
          when v_definition.content_unit_id = v_definition.unit_id
            then v_new_unit_id
          else v_definition.content_unit_id
        end,
        u.is_active,
        u.sort_order + v_definition.definition_number - 1
      from public.inventory_units u
      where u.id = v_definition.unit_id
        and u.tenant_id = v_definition.tenant_id
        and u.venue_id = v_definition.venue_id;

      update public.inventory_product_settings
      set unit_id = v_new_unit_id
      where unit_id = v_definition.unit_id
        and tenant_id = v_definition.tenant_id
        and venue_id = v_definition.venue_id
        and content_quantity = v_definition.content_quantity
        and content_unit_id = v_definition.content_unit_id;
    end if;
  end loop;
end;
$$;

update public.inventory_units
set content_quantity = 1,
    content_unit_id = id
where content_quantity is null
   or content_unit_id is null;

alter table public.inventory_units
  alter column content_quantity set default 1,
  alter column content_quantity set not null,
  alter column content_unit_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.inventory_units'::regclass
      and conname = 'inventory_units_content_quantity_check'
  ) then
    alter table public.inventory_units
      add constraint inventory_units_content_quantity_check
      check (content_quantity > 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.inventory_units'::regclass
      and conname = 'inventory_units_content_unit_scope_fk'
  ) then
    alter table public.inventory_units
      add constraint inventory_units_content_unit_scope_fk
      foreign key (content_unit_id, tenant_id, venue_id)
      references public.inventory_units(id, tenant_id, venue_id);
  end if;
end;
$$;

-- Keep deprecated columns synchronized while old clients or installations
-- still know about them. The unit is now the authoritative definition.
update public.inventory_product_settings s
set content_quantity = u.content_quantity,
    content_unit_id = u.content_unit_id
from public.inventory_units u
where u.id = s.unit_id
  and u.tenant_id = s.tenant_id
  and u.venue_id = s.venue_id;

create or replace function public.validate_inventory_unit_equivalence()
returns trigger
language plpgsql
set search_path to ''
as $$
declare
  v_content_decimal_places integer;
  v_nested_content_quantity numeric(18, 6);
  v_nested_content_unit_id uuid;
begin
  if new.content_quantity is null
    or new.content_quantity <= 0
    or new.content_quantity > 999999999999.999999
  then
    raise exception 'INVENTORY_INVALID_CONTENT_QUANTITY' using errcode = '22023';
  end if;

  if new.content_unit_id = new.id then
    if new.content_quantity <> 1 then
      raise exception 'INVENTORY_BASE_UNIT_MUST_EQUAL_ONE' using errcode = '22023';
    end if;
    return new;
  end if;

  select u.decimal_places, u.content_quantity, u.content_unit_id
  into v_content_decimal_places, v_nested_content_quantity, v_nested_content_unit_id
  from public.inventory_units u
  where u.id = new.content_unit_id
    and u.tenant_id = new.tenant_id
    and u.venue_id = new.venue_id
    and u.is_active = true;

  if v_content_decimal_places is null then
    raise exception 'INVENTORY_CONTENT_UNIT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_nested_content_unit_id <> new.content_unit_id
    or v_nested_content_quantity <> 1
  then
    raise exception 'INVENTORY_CONTENT_UNIT_MUST_BE_BASE_UNIT' using errcode = '22023';
  end if;

  if round(new.content_quantity, v_content_decimal_places) <> new.content_quantity then
    raise exception 'INVENTORY_INVALID_CONTENT_QUANTITY' using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_inventory_unit_equivalence on public.inventory_units;
create trigger validate_inventory_unit_equivalence
before insert or update of content_quantity, content_unit_id, tenant_id, venue_id
on public.inventory_units
for each row execute function public.validate_inventory_unit_equivalence();

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
    from public.inventory_product_settings s
    join public.inventory_stock_levels l
      on l.product_id = s.product_id
     and l.tenant_id = s.tenant_id
     and l.venue_id = s.venue_id
    where s.unit_id = old.id
      and s.tenant_id = old.tenant_id
      and s.venue_id = old.venue_id
      and l.quantity <> 0
  ) then
    raise exception 'INVENTORY_UNIT_CHANGE_WITH_STOCK' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_inventory_unit_equivalence_change_with_stock on public.inventory_units;
create trigger prevent_inventory_unit_equivalence_change_with_stock
before update of content_quantity, content_unit_id
on public.inventory_units
for each row execute function public.prevent_inventory_unit_equivalence_change_with_stock();

create or replace function public.validate_inventory_format_consumption_unit()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if new.inventory_consumption_unit_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.inventory_units u
    where u.id = new.inventory_consumption_unit_id
      and u.tenant_id = new.tenant_id
      and u.venue_id = new.venue_id
      and u.is_active = true
      and u.content_unit_id = u.id
      and u.content_quantity = 1
  ) then
    raise exception 'CATALOG_SALE_FORMAT_INVENTORY_UNIT_MUST_BE_BASE_UNIT'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_inventory_format_consumption_unit
  on public.catalog_sale_formats;
create trigger validate_inventory_format_consumption_unit
before insert or update of inventory_consumption_unit_id, tenant_id, venue_id
on public.catalog_sale_formats
for each row execute function public.validate_inventory_format_consumption_unit();

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

  delete from public.inventory_product_format_consumptions
  where product_id = p_product_id
    and tenant_id = p_tenant_id
    and venue_id = p_venue_id;
end;
$$;

revoke all on function public.set_inventory_product_stock(
  uuid, uuid, uuid, uuid, jsonb
) from public, anon;
grant execute on function public.set_inventory_product_stock(
  uuid, uuid, uuid, uuid, jsonb
) to authenticated;

revoke execute on function public.set_inventory_product_stock(
  uuid, uuid, uuid, uuid, numeric, uuid, jsonb
) from authenticated;

create or replace function public.consume_inventory_product(
  p_ticket_line_id uuid,
  p_tenant_id uuid,
  p_venue_id uuid,
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

  for v_stock in
    select l.warehouse_id, l.quantity, w.sort_order, w.name
    from public.inventory_stock_levels l
    join public.inventory_warehouses w
      on w.id = l.warehouse_id
     and w.tenant_id = l.tenant_id
     and w.venue_id = l.venue_id
    where l.product_id = p_product_id
      and l.tenant_id = p_tenant_id
      and l.venue_id = p_venue_id
      and l.quantity > 0
      and w.is_active = true
    order by w.sort_order, w.name, w.id
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

  if v_remaining > 0 then
    raise exception 'INVENTORY_INSUFFICIENT_STOCK product=% missing=%',
      p_product_id,
      v_remaining
      using errcode = 'P0001';
  end if;
end;
$$;

comment on column public.inventory_units.content_quantity is
  'Amount of content_unit_id represented by one stock unit.';
comment on column public.inventory_units.content_unit_id is
  'Base inventory unit used by sale-format consumption calculations.';
