alter function public.save_catalog_order_lines(uuid, integer, jsonb)
rename to save_catalog_order_lines_canonical;

revoke all on function public.save_catalog_order_lines_canonical(uuid, integer, jsonb) from public;
revoke all on function public.save_catalog_order_lines_canonical(uuid, integer, jsonb) from authenticated;

create function public.save_catalog_order_lines(
  p_order_id uuid,
  p_expected_revision integer,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_order jsonb;
  saved_lines jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'CATALOG_LINES_MUST_BE_ARRAY' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) submitted(line)
    where submitted.line ? 'unitPriceCents'
      and (
        jsonb_typeof(submitted.line -> 'unitPriceCents') <> 'number'
        or submitted.line ->> 'unitPriceCents' !~ '^[0-9]+$'
        or (submitted.line ->> 'unitPriceCents')::numeric > 2147483647
      )
  ) then
    raise exception 'ORDER_LINE_INVALID_UNIT_PRICE' using errcode = '22023';
  end if;

  saved_order := public.save_catalog_order_lines_canonical(p_order_id, p_expected_revision, p_lines);

  update public.order_lines as order_line
  set unit_price_cents = (submitted.line ->> 'unitPriceCents')::integer
  from jsonb_array_elements(p_lines) submitted(line)
  where submitted.line ? 'unitPriceCents'
    and order_line.order_id = p_order_id
    and order_line.id = (submitted.line ->> 'id')::uuid;

  select coalesce(
    jsonb_agg(
      saved_line.value || jsonb_build_object('unitPriceCents', order_line.unit_price_cents)
      order by saved_line.position
    ),
    '[]'::jsonb
  )
  into saved_lines
  from jsonb_array_elements(coalesce(saved_order -> 'lines', '[]'::jsonb))
    with ordinality saved_line(value, position)
  join public.order_lines order_line
    on order_line.id = (saved_line.value ->> 'id')::uuid
    and order_line.order_id = p_order_id;

  return jsonb_set(saved_order, '{lines}', saved_lines);
end;
$$;

comment on function public.save_catalog_order_lines(uuid, integer, jsonb)
is 'Persists a restaurant draft with canonical catalogue selections while preserving operator-edited unit prices.';

revoke all on function public.save_catalog_order_lines(uuid, integer, jsonb) from public;
grant execute on function public.save_catalog_order_lines(uuid, integer, jsonb) to authenticated;

notify pgrst, 'reload schema';
