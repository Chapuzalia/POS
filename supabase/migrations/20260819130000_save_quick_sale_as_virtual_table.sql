-- Persist a quick-sale draft as a standard temporary table and restaurant order
-- in one transaction. No quick-sale-specific entity survives after this call.
alter table public.orders
  add column if not exists draft_discount jsonb;

comment on column public.orders.draft_discount is
  'Current unpaid order discount/promotion, used to restore the draft across POS devices.';

create or replace function public.save_quick_sale_as_virtual_table(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_area_id uuid,
  p_name text,
  p_capacity integer,
  p_shape text,
  p_lines jsonb,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_table_id uuid;
  new_order_id uuid;
  saved_order jsonb;
begin
  if p_area_id is null then
    raise exception 'Selecciona una sala para la mesa virtual' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'La Venta rápida no contiene productos' using errcode = '22023';
  end if;
  if p_discount is not null and jsonb_typeof(p_discount) <> 'object' then
    raise exception 'El descuento de la cuenta no es válido' using errcode = '22023';
  end if;

  new_table_id := public.create_virtual_restaurant_table(
    p_cash_session_id,
    p_device_id,
    p_area_id,
    p_name,
    p_capacity,
    p_shape
  );
  new_order_id := public.open_restaurant_order(
    array[new_table_id],
    greatest(1, p_capacity),
    p_cash_session_id,
    p_device_id
  );
  saved_order := public.save_catalog_order_lines(new_order_id, 0, p_lines);

  update public.orders
  set draft_discount = p_discount
  where id = new_order_id;

  return jsonb_build_object(
    'tableId', new_table_id,
    'orderId', new_order_id,
    'revision', (saved_order ->> 'revision')::integer
  );
end;
$$;

revoke all on function public.save_quick_sale_as_virtual_table(uuid, uuid, uuid, text, integer, text, jsonb, jsonb) from public;
grant execute on function public.save_quick_sale_as_virtual_table(uuid, uuid, uuid, text, integer, text, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
