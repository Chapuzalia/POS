-- Cierra sin venta una comanda abierta que continúa vacía y libera todas sus mesas.

create or replace function public.cancel_empty_restaurant_order(
  p_order_id uuid,
  p_expected_revision integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  next_revision integer;
begin
  select o.* into order_row
  from public.orders o
  where o.id = p_order_id
  for update;

  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;

  if order_row.revision <> p_expected_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo'
      using errcode = '40001',
        detail = jsonb_build_object(
          'expectedRevision', p_expected_revision,
          'currentRevision', order_row.revision
        )::text;
  end if;

  perform 1
  from public.order_lines ol
  where ol.order_id = order_row.id
  order by ol.id
  for update;

  if exists (
    select 1 from public.order_lines ol where ol.order_id = order_row.id
  ) then
    raise exception 'La comanda ya contiene productos' using errcode = '23514';
  end if;

  update public.orders o
  set status = 'cancelled', closed_at = now(), revision = o.revision + 1
  where o.id = order_row.id
  returning o.revision into next_revision;

  update public.order_tables ot
  set released_at = now()
  where ot.order_id = order_row.id and ot.released_at is null;

  return next_revision;
end;
$$;

revoke all on function public.cancel_empty_restaurant_order(uuid, integer) from public;
grant execute on function public.cancel_empty_restaurant_order(uuid, integer) to authenticated;
