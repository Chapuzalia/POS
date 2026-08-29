-- Park a quick-sale draft on an existing free table in one transaction.
create or replace function public.save_quick_sale_as_existing_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_table_id uuid,
  p_lines jsonb,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_order_id uuid;
  saved_order jsonb;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'La Venta rápida no contiene productos' using errcode = '22023';
  end if;
  if p_discount is not null and jsonb_typeof(p_discount) <> 'object' then
    raise exception 'El descuento de la cuenta no es válido' using errcode = '22023';
  end if;

  new_order_id := public.open_restaurant_order(
    array[p_table_id],
    1,
    p_cash_session_id,
    p_device_id
  );
  saved_order := public.save_catalog_order_lines(new_order_id, 0, p_lines);

  update public.orders
  set draft_discount = p_discount
  where id = new_order_id;

  return jsonb_build_object(
    'tableId', p_table_id,
    'orderId', new_order_id,
    'revision', (saved_order ->> 'revision')::integer
  );
end;
$$;

revoke all on function public.save_quick_sale_as_existing_table(uuid, uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.save_quick_sale_as_existing_table(uuid, uuid, uuid, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
