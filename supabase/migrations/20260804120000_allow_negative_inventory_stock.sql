-- Sales must keep consuming configured inventory even when the available
-- quantity has been exhausted. Manual stock configuration remains
-- non-negative; only automatic consumption can create an overdraft.

alter table public.inventory_stock_levels
  drop constraint if exists inventory_stock_levels_quantity_check;

alter table public.inventory_stock_movements
  drop constraint if exists inventory_stock_movements_delta_check;

alter table public.inventory_stock_movements
  add constraint inventory_stock_movements_delta_check
  check (
    stock_quantity_delta < 0
    and stock_quantity_before + stock_quantity_delta = stock_quantity_after
  );

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

  -- Preserve the existing warehouse priority while positive stock remains.
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

  if v_remaining <= 0 then return; end if;

  -- Put any unfulfilled consumption into the first active warehouse. This
  -- also creates its zero level when the product was configured without one.
  select w.id into v_overflow_warehouse_id
  from public.inventory_warehouses w
  where w.tenant_id = p_tenant_id
    and w.venue_id = p_venue_id
    and w.is_active = true
  order by w.sort_order, w.name, w.id
  limit 1;

  if v_overflow_warehouse_id is null then return; end if;

  insert into public.inventory_stock_levels (
    warehouse_id,
    product_id,
    tenant_id,
    venue_id,
    quantity
  )
  values (
    v_overflow_warehouse_id,
    p_product_id,
    p_tenant_id,
    p_venue_id,
    0
  )
  on conflict (warehouse_id, product_id) do nothing;

  select l.quantity into v_overflow_quantity
  from public.inventory_stock_levels l
  where l.warehouse_id = v_overflow_warehouse_id
    and l.product_id = p_product_id
  for update;

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
