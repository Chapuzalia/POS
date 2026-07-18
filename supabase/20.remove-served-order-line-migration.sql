-- Permite eliminar una línea servida tras confirmación explícita en el TPV.

create or replace function public.remove_restaurant_order_line_confirmed(
  p_line_id uuid,
  p_expected_revision integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  line_row public.order_lines%rowtype;
  next_revision integer;
begin
  select o.* into order_row
  from public.orders o
  join public.order_lines ol on ol.order_id = o.id
  where ol.id = p_line_id
  for update of o;

  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Línea de comanda no disponible' using errcode = '42501';
  end if;

  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo'
      using errcode = '40001', detail = jsonb_build_object(
        'expectedRevision', p_expected_revision,
        'currentRevision', order_row.revision
      )::text;
  end if;

  select ol.* into line_row
  from public.order_lines ol
  where ol.id = p_line_id and ol.order_id = order_row.id
  for update;

  if line_row.id is null then
    raise exception 'Línea de comanda no disponible' using errcode = 'P0002';
  end if;

  perform public.record_restaurant_order_event(
    order_row.id,
    'line_quantity_changed',
    jsonb_build_object(
      'lineId', line_row.id,
      'oldQuantity', line_row.quantity,
      'quantity', 0,
      'servedQuantity', line_row.served_quantity,
      'removed', true
    )
  );

  delete from public.order_lines ol where ol.id = line_row.id;
  update public.orders o
  set revision = o.revision + 1
  where o.id = order_row.id
  returning o.revision into next_revision;

  return next_revision;
end;
$$;

revoke all on function public.remove_restaurant_order_line_confirmed(uuid, integer) from public;
grant execute on function public.remove_restaurant_order_line_confirmed(uuid, integer) to authenticated;
