-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New authenticated-only RPC; retain existing layout signatures and use their atomic revision check and authorization.

create function public.restore_venue_table_layout(p_venue_id uuid, p_expected_revision bigint)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  layout jsonb;
  initial_tables jsonb;
begin
  -- This existing RPC validates the authenticated user's tenant and venue access.
  layout := public.get_venue_table_layout(p_venue_id);
  if (layout ->> 'revision')::bigint is distinct from p_expected_revision then
    raise exception 'La distribución ha cambiado en otro dispositivo' using errcode = '40001';
  end if;

  if exists (
    select 1 from jsonb_each(layout -> 'tables') item
    where nullif(item.value ->> 'groupId', '') is not null
  ) or exists (
    select 1
    from public.order_tables ot
    join public.orders o on o.id = ot.order_id and o.status = 'open'
    where ot.venue_id = p_venue_id and ot.tenant_id = o.tenant_id
      and o.venue_id = p_venue_id and ot.released_at is null and ot.table_id is not null
    group by coalesce(ot.order_group_id, o.order_group_id, o.id)
    having count(distinct ot.table_id) > 1
  ) then
    raise exception 'Separa todas las mesas juntadas para recuperar el mapa inicial' using errcode = '55000';
  end if;

  -- CRM owns the permanent floor plan. Temporary tables have no CRM baseline:
  -- retain their current position and every existing order/reservation.
  select coalesce(jsonb_object_agg(rt.id::text,
    case when rt.cash_session_id is null then jsonb_build_object(
      'positionX', rt.position_x, 'positionY', rt.position_y, 'groupId', null)
    else coalesce(layout -> 'tables' -> rt.id::text, jsonb_build_object(
      'positionX', rt.position_x, 'positionY', rt.position_y, 'groupId', null)) end
  ), '{}'::jsonb) into initial_tables
  from public.restaurant_tables rt
  join public.venues v on v.id = rt.venue_id and v.tenant_id = rt.tenant_id
  where rt.venue_id = p_venue_id and rt.is_active;

  -- A concurrent join/save changes this revision. The existing writer locks the
  -- venue/layout and rejects it instead of clearing a newly formed composition.
  return public.save_venue_table_layout(p_venue_id, p_expected_revision, initial_tables);
end;
$$;

revoke all on function public.restore_venue_table_layout(uuid,bigint) from public, anon;
grant execute on function public.restore_venue_table_layout(uuid,bigint) to authenticated;
