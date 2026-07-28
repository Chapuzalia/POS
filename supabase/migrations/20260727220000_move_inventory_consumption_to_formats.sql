-- Inventory recipes belong to reusable sale formats. A ticket-line trigger
-- consumes the main product and every selected mixer/component atomically.

alter table public.catalog_sale_formats
  add column if not exists inventory_consumption_quantity numeric(18, 6),
  add column if not exists inventory_consumption_unit_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.catalog_sale_formats'::regclass
      and conname = 'catalog_sale_formats_inventory_consumption_check'
  ) then
    alter table public.catalog_sale_formats
      add constraint catalog_sale_formats_inventory_consumption_check
      check (
        (inventory_consumption_quantity is null and inventory_consumption_unit_id is null)
        or (inventory_consumption_quantity > 0 and inventory_consumption_unit_id is not null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.catalog_sale_formats'::regclass
      and conname = 'catalog_sale_formats_inventory_unit_scope_fk'
  ) then
    alter table public.catalog_sale_formats
      add constraint catalog_sale_formats_inventory_unit_scope_fk
      foreign key (inventory_consumption_unit_id, tenant_id, venue_id)
      references public.inventory_units(id, tenant_id, venue_id);
  end if;
end;
$$;

-- Preserve legacy per-product recipes only when every product agreed on the
-- same quantity and unit. Ambiguous recipes remain unset for manual review.
with consistent_recipes as (
  select
    c.sale_format_id,
    min(c.quantity) quantity,
    min(s.content_unit_id::text)::uuid unit_id
  from public.inventory_product_format_consumptions c
  join public.inventory_product_settings s
    on s.product_id = c.product_id
   and s.tenant_id = c.tenant_id
   and s.venue_id = c.venue_id
  group by c.sale_format_id
  having count(distinct (c.quantity, s.content_unit_id)) = 1
)
update public.catalog_sale_formats f
set inventory_consumption_quantity = r.quantity,
    inventory_consumption_unit_id = r.unit_id,
    updated_at = now()
from consistent_recipes r
where f.id = r.sale_format_id
  and f.inventory_consumption_quantity is null
  and f.inventory_consumption_unit_id is null;

comment on table public.inventory_product_format_consumptions is
  'Deprecated compatibility storage. Active inventory recipes are configured on catalog_sale_formats.';

create table if not exists public.inventory_stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  warehouse_id uuid not null,
  product_id uuid not null,
  ticket_line_id uuid not null,
  sale_format_id uuid not null,
  source_type text not null,
  stock_quantity_delta numeric(18, 6) not null,
  stock_quantity_before numeric(18, 6) not null,
  stock_quantity_after numeric(18, 6) not null,
  format_consumption_quantity numeric(18, 6) not null,
  sold_quantity numeric(18, 9) not null,
  content_unit_id uuid not null,
  created_at timestamptz not null default now(),
  constraint inventory_stock_movements_source_type_check
    check (source_type in ('product', 'mixer', 'menu_component')),
  constraint inventory_stock_movements_delta_check
    check (
      stock_quantity_delta < 0
      and stock_quantity_after >= 0
      and stock_quantity_before + stock_quantity_delta = stock_quantity_after
    )
);

create index if not exists inventory_stock_movements_product_created_idx
  on public.inventory_stock_movements (tenant_id, venue_id, product_id, created_at desc);

create index if not exists inventory_stock_movements_ticket_line_idx
  on public.inventory_stock_movements (ticket_line_id);

create or replace function public.set_inventory_product_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_product_id uuid,
  p_unit_id uuid,
  p_content_quantity numeric,
  p_content_unit_id uuid,
  p_levels jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  perform public.set_inventory_product_stock(
    p_tenant_id,
    p_venue_id,
    p_product_id,
    p_unit_id,
    p_content_quantity,
    p_content_unit_id,
    p_levels,
    '[]'::jsonb
  );
end;
$$;

create or replace function public.get_catalog(
  p_venue_id uuid,
  p_mode text default 'admin'
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_catalog jsonb;
  v_active_only boolean;
begin
  v_catalog := public.get_catalog_without_formats(p_venue_id, p_mode);
  v_active_only := p_mode = 'pos';
  return v_catalog || jsonb_build_object(
    'sale_formats', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id)
      from (
        select
          f.id,
          f.tenant_id,
          f.venue_id,
          f.name,
          f.inventory_consumption_quantity,
          f.inventory_consumption_unit_id,
          f.is_active,
          f.sort_order,
          f.created_at,
          f.updated_at
        from public.catalog_sale_formats f
        where f.venue_id = p_venue_id
          and (not v_active_only or f.is_active)
      ) x
    ), '[]'::jsonb),
    'variant_formats', coalesce((
      select jsonb_agg(
        jsonb_build_object('variant_id', v.id, 'format_id', f.id)
        order by v.product_id, v.sort_order, v.id
      )
      from public.product_variants v
      join public.products p
        on p.id = v.product_id
       and p.venue_id = p_venue_id
      join public.catalog_sale_formats f
        on f.id = v.catalog_sale_format_id
       and f.venue_id = p_venue_id
      where v.venue_id = p_venue_id
        and (not v_active_only or (p.is_active and v.is_active and f.is_active))
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.catalog_sale_format_command(
  p_venue_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_id uuid;
  v_item jsonb;
  v_name text;
  v_has_consumption boolean;
  v_consumption_quantity numeric(18, 6);
  v_consumption_unit_id uuid;
  v_decimal_places integer;
begin
  select v.tenant_id into v_tenant_id
  from public.venues v
  where v.id = p_venue_id
  for update;

  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role'
    and not public.user_is_tenant_admin(v_tenant_id)
  then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;

  if p_action = 'save' then
    v_name := trim(p_payload ->> 'name');
    if coalesce(v_name, '') = '' then
      raise exception 'CATALOG_SALE_FORMAT_NAME_REQUIRED';
    end if;

    v_has_consumption :=
      p_payload ? 'inventoryConsumptionQuantity'
      or p_payload ? 'inventoryConsumptionUnitId';
    if v_has_consumption then
      v_consumption_quantity :=
        nullif(p_payload ->> 'inventoryConsumptionQuantity', '')::numeric;
      v_consumption_unit_id :=
        nullif(p_payload ->> 'inventoryConsumptionUnitId', '')::uuid;

      if (v_consumption_quantity is null) <> (v_consumption_unit_id is null) then
        raise exception 'CATALOG_SALE_FORMAT_INVENTORY_CONSUMPTION_INCOMPLETE';
      end if;

      if v_consumption_quantity is not null then
        select u.decimal_places into v_decimal_places
        from public.inventory_units u
        where u.id = v_consumption_unit_id
          and u.tenant_id = v_tenant_id
          and u.venue_id = p_venue_id
          and u.is_active = true;
        if v_decimal_places is null then
          raise exception 'CATALOG_SALE_FORMAT_INVENTORY_UNIT_NOT_FOUND';
        end if;
        if v_consumption_quantity <= 0
          or round(v_consumption_quantity, v_decimal_places) <> v_consumption_quantity
        then
          raise exception 'CATALOG_SALE_FORMAT_INVENTORY_QUANTITY_INVALID';
        end if;
      end if;
    end if;

    v_id := nullif(p_payload ->> 'id', '')::uuid;
    if v_id is null then
      insert into public.catalog_sale_formats (
        tenant_id,
        venue_id,
        name,
        inventory_consumption_quantity,
        inventory_consumption_unit_id,
        is_active,
        sort_order
      )
      values (
        v_tenant_id,
        p_venue_id,
        v_name,
        v_consumption_quantity,
        v_consumption_unit_id,
        coalesce((p_payload ->> 'active')::boolean, true),
        coalesce((p_payload ->> 'sortOrder')::integer, 0)
      )
      returning id into v_id;
    else
      update public.catalog_sale_formats
      set name = v_name,
          inventory_consumption_quantity = case
            when v_has_consumption then v_consumption_quantity
            else inventory_consumption_quantity
          end,
          inventory_consumption_unit_id = case
            when v_has_consumption then v_consumption_unit_id
            else inventory_consumption_unit_id
          end,
          is_active = coalesce((p_payload ->> 'active')::boolean, is_active),
          sort_order = coalesce((p_payload ->> 'sortOrder')::integer, sort_order)
      where id = v_id
        and venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND'; end if;
    end if;

    update public.product_variants
    set name = v_name
    where catalog_sale_format_id = v_id
      and venue_id = p_venue_id;
  elsif p_action = 'delete' then
    v_id := (p_payload ->> 'id')::uuid;
    if exists (
      select 1 from public.product_variants
      where catalog_sale_format_id = v_id
        and venue_id = p_venue_id
    ) then
      raise exception 'CATALOG_SALE_FORMAT_IN_USE';
    end if;
    delete from public.catalog_sale_formats
    where id = v_id
      and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND'; end if;
  elsif p_action = 'reorder' then
    for v_item in
      select value
      from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb))
    loop
      update public.catalog_sale_formats
      set sort_order = (v_item ->> 'sortOrder')::integer
      where id = (v_item ->> 'id')::uuid
        and venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND'; end if;
    end loop;
  else
    raise exception 'CATALOG_SALE_FORMAT_ACTION_INVALID';
  end if;

  return jsonb_build_object('result', 'SUCCESS', 'id', v_id);
end;
$$;

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

  select s.unit_id, s.content_quantity, s.content_unit_id
  into v_stock_unit_id, v_content_quantity, v_content_unit_id
  from public.inventory_product_settings s
  where s.product_id = p_product_id
    and s.tenant_id = p_tenant_id
    and s.venue_id = p_venue_id;

  -- Formats can be shared by products that are not inventory-managed.
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
    select
      l.warehouse_id,
      l.quantity,
      w.sort_order,
      w.name
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

create or replace function public.snapshot_ticket_line_sale_format()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.variant_id is not null then
    select f.id, f.name
    into new.sale_format_id, new.sale_format_name_snapshot
    from public.product_variants pv
    join public.catalog_sale_formats f
      on f.id = pv.catalog_sale_format_id
     and f.tenant_id = pv.tenant_id
     and f.venue_id = pv.venue_id
    where pv.id = new.variant_id
      and pv.product_id = new.product_id
      and pv.tenant_id = new.tenant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists snapshot_ticket_line_sale_format on public.ticket_lines;
create trigger snapshot_ticket_line_sale_format
before insert on public.ticket_lines
for each row execute function public.snapshot_ticket_line_sale_format();

create or replace function public.consume_ticket_line_inventory()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_venue_id uuid;
  v_sold_quantity numeric(18, 9);
  v_component record;
  v_modifier jsonb;
  v_mixer_product_id uuid;
  v_mixer_variant_id uuid;
begin
  select t.venue_id into v_venue_id
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
      v_component.product_id,
      v_component.variant_id,
      v_sold_quantity * v_component.quantity,
      case
        when v_component.component_type = 'mixer' then 'mixer'
        else 'menu_component'
      end
    );
  end loop;

  -- Legacy restaurant lines may expose the mixer only in the synthetic
  -- modifier snapshot. Use it only when no normalized mixer was captured.
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

drop trigger if exists consume_ticket_line_inventory on public.ticket_lines;
create trigger consume_ticket_line_inventory
after insert on public.ticket_lines
for each row execute function public.consume_ticket_line_inventory();

alter table public.inventory_stock_movements enable row level security;

drop policy if exists inventory_stock_movements_select
  on public.inventory_stock_movements;
create policy inventory_stock_movements_select
on public.inventory_stock_movements
for select
to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

revoke all on table public.inventory_stock_movements from public, anon;
grant select on table public.inventory_stock_movements to authenticated;

revoke all on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  uuid,
  jsonb
) from public, anon;
grant execute on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  uuid,
  jsonb
) to authenticated;
revoke execute on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  uuid,
  jsonb,
  jsonb
) from authenticated;
revoke all on function public.consume_inventory_product(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  text
) from public, anon, authenticated;
revoke all on function public.consume_ticket_line_inventory()
  from public, anon, authenticated;
revoke all on function public.snapshot_ticket_line_sale_format()
  from public, anon, authenticated;
