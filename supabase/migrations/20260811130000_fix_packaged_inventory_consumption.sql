-- Convert the sale-format unit to the product's physical stock unit before
-- consuming it. This covers both an exact shared base unit and equivalent
-- countable units such as "unidad" and "botellin".

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
  v_format_unit_content_quantity numeric(18, 6);
  v_format_base_unit_id uuid;
  v_format_base_name text;
  v_format_base_symbol text;
  v_format_base_decimal_places smallint;
  v_stock_unit_id uuid;
  v_stock_content_quantity numeric(18, 6);
  v_stock_base_unit_id uuid;
  v_stock_base_name text;
  v_stock_base_symbol text;
  v_stock_base_decimal_places smallint;
  v_units_compatible boolean;
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
    f.inventory_consumption_unit_id,
    format_unit.content_quantity,
    format_unit.content_unit_id,
    format_base.name,
    format_base.symbol,
    format_base.decimal_places
  into
    v_sale_format_id,
    v_format_quantity,
    v_format_unit_id,
    v_format_unit_content_quantity,
    v_format_base_unit_id,
    v_format_base_name,
    v_format_base_symbol,
    v_format_base_decimal_places
  from public.product_variants pv
  join public.catalog_sale_formats f
    on f.id = pv.catalog_sale_format_id
   and f.tenant_id = pv.tenant_id
   and f.venue_id = pv.venue_id
  join public.inventory_units format_unit
    on format_unit.id = f.inventory_consumption_unit_id
   and format_unit.tenant_id = f.tenant_id
   and format_unit.venue_id = f.venue_id
  join public.inventory_units format_base
    on format_base.id = format_unit.content_unit_id
   and format_base.tenant_id = format_unit.tenant_id
   and format_base.venue_id = format_unit.venue_id
  where pv.id = v_variant_id
    and pv.product_id = p_product_id
    and pv.tenant_id = p_tenant_id
    and pv.venue_id = p_venue_id;

  if v_format_quantity is null
    or v_format_unit_id is null
    or v_format_unit_content_quantity is null
    or v_format_base_unit_id is null
  then
    return;
  end if;

  select
    s.unit_id,
    stock_unit.content_quantity,
    stock_unit.content_unit_id,
    stock_base.name,
    stock_base.symbol,
    stock_base.decimal_places
  into
    v_stock_unit_id,
    v_stock_content_quantity,
    v_stock_base_unit_id,
    v_stock_base_name,
    v_stock_base_symbol,
    v_stock_base_decimal_places
  from public.inventory_product_settings s
  join public.inventory_units stock_unit
    on stock_unit.id = s.unit_id
   and stock_unit.tenant_id = s.tenant_id
   and stock_unit.venue_id = s.venue_id
  join public.inventory_units stock_base
    on stock_base.id = stock_unit.content_unit_id
   and stock_base.tenant_id = stock_unit.tenant_id
   and stock_base.venue_id = stock_unit.venue_id
  where s.product_id = p_product_id
    and s.tenant_id = p_tenant_id
    and s.venue_id = p_venue_id;

  if v_stock_unit_id is null then return; end if;

  v_units_compatible := v_stock_base_unit_id = v_format_base_unit_id
    or lower(btrim(v_stock_base_name)) = lower(btrim(v_format_base_name))
    or (
      btrim(v_stock_base_symbol) <> ''
      and lower(btrim(v_stock_base_symbol)) = lower(btrim(v_format_base_symbol))
    )
    or (
      v_stock_base_decimal_places = 0
      and v_format_base_decimal_places = 0
      and (
        lower(v_stock_base_name) ~ '(unidad|pieza|botell|lata|envase)'
        or lower(v_stock_base_symbol) ~ '^(u|ud|uds|pz|bot)$'
      )
      and (
        lower(v_format_base_name) ~ '(unidad|pieza|botell|lata|envase)'
        or lower(v_format_base_symbol) ~ '^(u|ud|uds|pz|bot)$'
      )
    );

  if not v_units_compatible then
    raise exception 'INVENTORY_CONSUMPTION_UNIT_MISMATCH product=% format=% stock_unit=% format_unit=%',
      p_product_id,
      v_sale_format_id,
      v_stock_base_unit_id,
      v_format_base_unit_id
      using errcode = '22023';
  end if;

  v_required_stock := round(
    (
      v_format_quantity
      * v_format_unit_content_quantity
      * p_sold_quantity
    ) / v_stock_content_quantity,
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
    ) values (
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
      v_stock_base_unit_id
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
  ) values (
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
    v_stock_base_unit_id
  );
end;
$$;

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

comment on function public.consume_inventory_product(
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  text
) is
  'Converts sale-format consumption to stock units and routes the atomic decrement through the warehouses available to the POS device.';
