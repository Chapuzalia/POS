\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_venue constant uuid := '11111111-1111-4111-8111-111111111111';
  v_result jsonb;
  v_product uuid;
begin
  if jsonb_array_length(public.get_catalog(v_venue, 'admin') -> 'products') = 0 then
    raise exception 'PHASE31_CLEAN_READ_EMPTY';
  end if;
  v_result := public.catalog_command(v_venue, 'create_product', jsonb_build_object(
    'type', 'standard', 'name', 'Automatic active default', 'vatRate', 21,
    'active', true, 'sortOrder', 999,
    'variants', jsonb_build_array(
      jsonb_build_object('name', 'Inactive first', 'priceCents', 100, 'active', false, 'sortOrder', 0),
      jsonb_build_object('name', 'Active second', 'priceCents', 200, 'active', true, 'sortOrder', 10)
    )
  ));
  v_product := (v_result ->> 'id')::uuid;
  if not exists (
    select 1 from public.product_variants
    where product_id = v_product and name = 'Active second' and is_active and is_default
  ) then raise exception 'PHASE31_ACTIVE_DEFAULT_NOT_SELECTED'; end if;
  if (select count(*) from public.product_variants where product_id = v_product and is_active and is_default) <> 1 then
    raise exception 'PHASE31_ACTIVE_DEFAULT_COUNT';
  end if;
  raise notice 'PHASE31_CLEAN_SMOKE_OK';
end;
$$;

rollback;
