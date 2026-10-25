-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve the event renderer signature, grants and existing lines; append the current kitchen comment on modification notices for old and new clients.
create or replace function public.production_render_event_lines(p_event_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  event_row public.production_events%rowtype;
  title text;
  lines jsonb;
begin
  select * into event_row from public.production_events where id = p_event_id;
  title := case event_row.event_type
    when 'cancelled' then '******** ANULACIÓN ********'
    when 'table_moved' then '******* CAMBIO DE MESA *******'
    else '******** MODIFICACIÓN ********'
  end;
  if event_row.event_type = 'table_moved' then
    return jsonb_build_array(title, 'MESA ' || upper(coalesce(event_row.payload->>'tableName', 'COMANDA')),
      coalesce(event_row.payload->>'detail', 'La comanda ha cambiado de mesa'), '****************************');
  end if;
  lines := jsonb_build_array(title, 'MESA ' || upper(coalesce(event_row.payload->>'tableName', 'COMANDA')),
    event_row.quantity::text || 'x ' || coalesce(event_row.payload->>'productName', 'Producto'),
    coalesce(event_row.payload->>'detail', ''));
  if event_row.event_type = 'modified' and event_row.payload ? 'note' then
    lines := lines || jsonb_build_array('NOTA: ' || coalesce(nullif(btrim(event_row.payload->>'note'), ''), 'SIN COMENTARIO'));
  end if;
  return lines || jsonb_build_array('****************************');
end;
$$;
