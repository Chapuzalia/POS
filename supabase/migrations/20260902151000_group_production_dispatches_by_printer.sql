-- Keep KDS destinations independent, but collapse the physical output queue to
-- one dispatch per agent/printer inside a batch.

alter table public.production_printer_dispatches
  add column destination_ids uuid[];

update public.production_printer_dispatches
set destination_ids = array[destination_id]
where destination_ids is null;

alter table public.production_printer_dispatches
  alter column destination_ids set default '{}'::uuid[],
  alter column destination_ids set not null,
  add constraint production_dispatch_destination_ids_check check (
    cardinality(destination_ids) > 0 and destination_id = any(destination_ids)
  );

create or replace function public.ensure_production_dispatch_destination_ids()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if cardinality(new.destination_ids) = 0 then new.destination_ids := array[new.destination_id]; end if;
  if not new.destination_id = any(new.destination_ids) then
    raise exception 'El destino representativo debe pertenecer al dispatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ensure_production_dispatch_destination_ids_before_write
before insert or update of destination_id, destination_ids on public.production_printer_dispatches
for each row execute function public.ensure_production_dispatch_destination_ids();

create or replace function public.production_item_print_context(p_snapshot jsonb, p_quantity integer)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare details jsonb := '[]'::jsonb; modifier jsonb; note_value text;
begin
  if nullif(btrim(coalesce(p_snapshot ->> 'variantName', '')), '') is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(p_snapshot ->> 'variantName')));
  end if;
  if nullif(btrim(coalesce(p_snapshot ->> 'parentProductName', '')), '') is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  MENÚ: ' || upper(p_snapshot ->> 'parentProductName')));
  end if;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'lineModifiers', '[]'::jsonb)) loop
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(coalesce(modifier ->> 'name', ''))));
  end loop;
  for modifier in select value from jsonb_array_elements(coalesce(p_snapshot -> 'componentModifiers', '[]'::jsonb)) loop
    details := details || jsonb_build_array(jsonb_build_object('text', '  ' || upper(coalesce(modifier ->> 'name', ''))));
  end loop;
  note_value := nullif(btrim(coalesce(p_snapshot ->> 'note', '')), '');
  if note_value is not null then
    details := details || jsonb_build_array(jsonb_build_object('text', '  NOTA: ' || upper(note_value)));
  end if;
  return jsonb_build_object(
    'quantity', p_quantity,
    'name', coalesce(nullif(btrim(p_snapshot ->> 'productName'), ''), 'Producto'),
    'details', details
  );
end;
$$;

create or replace function public.production_batch_print_context(p_batch_id uuid, p_destination_ids uuid[])
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare batch_row public.production_batches%rowtype; venue_row public.venues%rowtype;
  destination_row public.production_destinations%rowtype; item_row public.production_items%rowtype;
  table_label text; destinations jsonb := '[]'::jsonb; items jsonb;
begin
  select * into batch_row from public.production_batches where id = p_batch_id;
  if batch_row.id is null then raise exception 'Batch de producción no disponible'; end if;
  select * into venue_row from public.venues where id = batch_row.venue_id;
  select coalesce(string_agg(table_ref.name, ' + ' order by table_ref.name), 'COMANDA') into table_label
  from public.orders order_ref
  join public.order_tables link on link.order_group_id = order_ref.order_group_id and link.released_at is null
  join public.restaurant_tables table_ref on table_ref.id = link.table_id
  where order_ref.id = batch_row.order_id;

  for destination_row in
    select destination.* from public.production_destinations destination
    where destination.id = any(p_destination_ids)
    order by destination.sort_order, destination.name, destination.id
  loop
    items := '[]'::jsonb;
    for item_row in
      select item.* from public.production_items item
      where item.batch_id = p_batch_id and item.destination_id = destination_row.id
      order by item.created_at, item.id
    loop
      items := items || jsonb_build_array(public.production_item_print_context(item_row.snapshot, item_row.quantity));
    end loop;
    if jsonb_array_length(items) > 0 then
      destinations := destinations || jsonb_build_array(jsonb_build_object(
        'id', destination_row.id,
        'name', upper(destination_row.name),
        'items', items
      ));
    end if;
  end loop;

  return jsonb_build_object(
    'venue', jsonb_build_object('name', venue_row.name, 'address', coalesce(venue_row.address, '')),
    'ticket', jsonb_build_object(
      'date', to_char(batch_row.created_at at time zone venue_row.timezone, 'YYYY-MM-DD'),
      'time', to_char(batch_row.created_at at time zone venue_row.timezone, 'HH24:MI'),
      'datetime', to_char(batch_row.created_at at time zone venue_row.timezone, 'YYYY-MM-DD HH24:MI')
    ),
    'table', jsonb_build_object('name', upper(table_label)),
    'order', jsonb_build_object('number', batch_row.sequence),
    'destinations', destinations
  );
end;
$$;

create or replace function public.production_render_batch_lines(p_batch_id uuid, p_destination_id uuid)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare batch_row public.production_batches%rowtype;
begin
  select * into batch_row from public.production_batches where id = p_batch_id;
  return public.print_render_template(
    'production', batch_row.tenant_id, batch_row.venue_id,
    public.production_batch_print_context(p_batch_id, array[p_destination_id]), 48
  ) -> 'lines';
end;
$$;

create or replace function public.production_create_batch_dispatches(p_batch_id uuid)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare target record; dispatch_id uuid; created_count integer := 0; rendered jsonb;
begin
  for target in
    select scoped.tenant_id, scoped.venue_id, scoped.agent_id, scoped.printer_id,
      scoped.paper_width, scoped.character_set,
      array_agg(scoped.destination_id order by scoped.sort_order, scoped.destination_name, scoped.destination_id) as destination_ids
    from (
      select distinct destination.id as destination_id, destination.tenant_id, destination.venue_id,
        destination.name as destination_name, destination.sort_order, destination.printer_id,
        agent.id as agent_id, printer.paper_width, printer.character_set
      from public.production_items item
      join public.production_destinations destination on destination.id = item.destination_id
      join public.production_print_agents agent
        on agent.tenant_id = destination.tenant_id and agent.venue_id = destination.venue_id
        and agent.is_active and agent.production_capability
      join public.production_agent_printers printer
        on printer.agent_id = agent.id and printer.printer_id = destination.printer_id
      where item.batch_id = p_batch_id and destination.printer_id is not null
    ) scoped
    group by scoped.tenant_id, scoped.venue_id, scoped.agent_id, scoped.printer_id,
      scoped.paper_width, scoped.character_set
  loop
    dispatch_id := gen_random_uuid();
    rendered := public.print_render_template(
      'production', target.tenant_id, target.venue_id,
      public.production_batch_print_context(p_batch_id, target.destination_ids),
      case when target.paper_width = 58 then 32 else 48 end
    );
    insert into public.production_printer_dispatches (
      id, tenant_id, venue_id, batch_id, destination_id, destination_ids,
      agent_id, printer_id, request_id, payload, paper_width, character_set
    ) values (
      dispatch_id, target.tenant_id, target.venue_id, p_batch_id, target.destination_ids[1], target.destination_ids,
      target.agent_id, target.printer_id, 'production:' || dispatch_id::text,
      jsonb_build_object('requestId', 'production:' || dispatch_id::text, 'printerId', target.printer_id)
        || rendered
        || jsonb_build_object('options', jsonb_build_object('cut', true, 'openCashDrawer', false, 'copies', 1)),
      target.paper_width, target.character_set
    );
    created_count := created_count + 1;
  end loop;
  return created_count;
end;
$$;

create or replace function public.reprint_production_dispatch(p_dispatch_id uuid, p_printer_id text default null)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare original public.production_printer_dispatches%rowtype;
  printer_row public.production_agent_printers%rowtype;
  new_id uuid := gen_random_uuid();
begin
  select * into original from public.production_printer_dispatches where id = p_dispatch_id;
  if original.id is null or not public.user_is_tenant_admin(original.tenant_id) then
    raise exception 'Dispatch no disponible' using errcode = '42501';
  end if;
  select * into printer_row from public.production_agent_printers
  where agent_id = original.agent_id and printer_id = coalesce(p_printer_id, original.printer_id);
  if printer_row.printer_id is null then raise exception 'Impresora no disponible'; end if;
  insert into public.production_printer_dispatches (
    id, tenant_id, venue_id, batch_id, event_id, destination_id, destination_ids,
    agent_id, printer_id, request_id, payload, paper_width, character_set
  ) values (
    new_id, original.tenant_id, original.venue_id, original.batch_id, original.event_id,
    original.destination_id, original.destination_ids, original.agent_id, printer_row.printer_id,
    'production:reprint:' || new_id::text,
    jsonb_set(
      jsonb_set(original.payload, '{requestId}', to_jsonb(('production:reprint:' || new_id::text)::text)),
      '{printerId}', to_jsonb(printer_row.printer_id::text)
    ),
    printer_row.paper_width, printer_row.character_set
  );
  return new_id;
end;
$$;

comment on column public.production_printer_dispatches.destination_id is
  'Representative destination retained for backwards compatibility; all physical destinations are in destination_ids.';
comment on column public.production_printer_dispatches.destination_ids is
  'Logical destinations combined into this single physical ticket.';
