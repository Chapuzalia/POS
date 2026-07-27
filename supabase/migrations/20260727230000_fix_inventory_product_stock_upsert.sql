-- Repair databases that already applied the first packaging migration before
-- its upsert ordering was corrected. The complete product setting must exist
-- before delegating stock-level validation to the legacy five-argument RPC.

create or replace function public.set_inventory_product_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_product_id uuid,
  p_unit_id uuid,
  p_content_quantity numeric,
  p_content_unit_id uuid,
  p_levels jsonb,
  p_consumptions jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_content_decimal_places integer;
  v_current_content_quantity numeric(18, 6);
  v_current_content_unit_id uuid;
  v_current_unit_id uuid;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_consumptions, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_consumptions, '[]'::jsonb)) <> 0
  then
    raise exception 'INVENTORY_PRODUCT_RECIPES_DEPRECATED' using errcode = '22023';
  end if;

  select u.decimal_places
  into v_content_decimal_places
  from public.inventory_units u
  where u.id = p_content_unit_id
    and u.tenant_id = p_tenant_id
    and u.venue_id = p_venue_id
    and u.is_active = true;

  if v_content_decimal_places is null then
    raise exception 'INVENTORY_CONTENT_UNIT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_content_quantity is null
    or p_content_quantity <= 0
    or p_content_quantity > 999999999999.999999
    or round(p_content_quantity, v_content_decimal_places) <> p_content_quantity
  then
    raise exception 'INVENTORY_INVALID_CONTENT_QUANTITY' using errcode = '22023';
  end if;

  select s.unit_id, s.content_quantity, s.content_unit_id
  into v_current_unit_id, v_current_content_quantity, v_current_content_unit_id
  from public.inventory_product_settings s
  where s.product_id = p_product_id
    and s.tenant_id = p_tenant_id
    and s.venue_id = p_venue_id;

  if v_current_unit_id is not null
    and (
      v_current_unit_id is distinct from p_unit_id
      or v_current_content_quantity is distinct from p_content_quantity
      or v_current_content_unit_id is distinct from p_content_unit_id
    )
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
    p_content_quantity::numeric(18, 6),
    p_content_unit_id
  )
  on conflict (product_id) do update
  set unit_id = excluded.unit_id,
      content_quantity = excluded.content_quantity,
      content_unit_id = excluded.content_unit_id,
      updated_at = now();

  perform public.set_inventory_product_stock(
    p_tenant_id,
    p_venue_id,
    p_product_id,
    p_unit_id,
    p_levels
  );

  delete from public.inventory_product_format_consumptions
  where product_id = p_product_id
    and tenant_id = p_tenant_id
    and venue_id = p_venue_id;
end;
$$;

revoke all on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  uuid,
  jsonb,
  jsonb
) from public, anon;
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
