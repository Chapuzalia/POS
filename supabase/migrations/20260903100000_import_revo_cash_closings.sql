-- Imported daily totals have no POS session, tickets, cash counts or fiscal side effects.
create table public.imported_cash_closings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  source text not null default 'revo' check (source = 'revo'),
  business_date date not null check (business_date between date '1900-01-01' and date '9999-12-31'),
  cash_cents integer not null,
  card_cents integer not null,
  cash_tip_cents integer not null,
  card_tip_cents integer not null,
  source_row_count integer not null check (source_row_count between 1 and 100000),
  file_name text not null check (length(file_name) between 1 and 255),
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  unique (tenant_id, venue_id, source, business_date)
);

alter table public.imported_cash_closings enable row level security;
create policy imported_cash_closings_select on public.imported_cash_closings
for select to authenticated using (
  public.user_has_tenant_role(tenant_id, array['owner'::text])
  or (public.user_has_tenant_role(tenant_id, array['manager'::text]) and exists (
    select 1 from public.manager_venue_assignments assignment
    where assignment.tenant_id = imported_cash_closings.tenant_id
      and assignment.venue_id = imported_cash_closings.venue_id
      and assignment.manager_user_id = (select auth.uid())
  ))
);
revoke all on table public.imported_cash_closings from public, anon, authenticated;
grant select on table public.imported_cash_closings to authenticated;
grant all on table public.imported_cash_closings to service_role;

create or replace function public.import_revo_cash_closings(p_venue_id uuid, p_file_name text, p_days jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  target_tenant uuid;
  membership_role text;
  day_value jsonb;
  date_value date;
  field_name text;
  existing public.imported_cash_closings%rowtype;
  inserted_count integer := 0;
  skipped_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Autenticación requerida' using errcode = '42501';
  end if;
  select venue.tenant_id into target_tenant from public.venues venue where venue.id = p_venue_id;
  select membership.role into membership_role from public.tenant_memberships membership
  where membership.tenant_id = target_tenant and membership.user_id = auth.uid() and membership.is_active;
  if membership_role is null or membership_role not in ('owner', 'manager') then
    raise exception 'No tienes permiso para importar cierres en este local' using errcode = '42501';
  end if;
  if membership_role = 'manager' and not exists (
    select 1 from public.manager_venue_assignments assignment
    where assignment.tenant_id = target_tenant and assignment.venue_id = p_venue_id
      and assignment.manager_user_id = auth.uid()
  ) then
    raise exception 'No tienes acceso a este local' using errcode = '42501';
  end if;
  if p_file_name is null or length(btrim(p_file_name)) not between 1 and 255 then
    raise exception 'Nombre de archivo no válido' using errcode = '22023';
  end if;
  if p_days is null or jsonb_typeof(p_days) <> 'array' then
    raise exception 'Los cierres deben ser una lista' using errcode = '22023';
  end if;
  if jsonb_array_length(p_days) not between 1 and 10000 then
    raise exception 'Se admiten entre 1 y 10.000 días por importación' using errcode = '22023';
  end if;
  -- Serialize imports per venue; a retry cannot race with another overlapping file.
  perform 1 from public.venues where id = p_venue_id for update;
  if (select count(distinct value->>'date') from jsonb_array_elements(p_days)) <> jsonb_array_length(p_days) then
    raise exception 'Cada día debe aparecer una sola vez y tener fecha' using errcode = '22023';
  end if;
  for day_value in select value from jsonb_array_elements(p_days) loop
    if jsonb_typeof(day_value) <> 'object' or coalesce(day_value->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'Fecha de cierre no válida' using errcode = '22023';
    end if;
    date_value := (day_value->>'date')::date;
    foreach field_name in array array['cashCents', 'cardCents', 'cashTipCents', 'cardTipCents', 'rowCount'] loop
      if jsonb_typeof(day_value->field_name) is distinct from 'number'
        or (day_value->>field_name) !~ '^-?[0-9]+$'
        or abs((day_value->>field_name)::numeric) > 2147483647 then
        raise exception 'Importe o número de filas no válido para el día %', date_value using errcode = '22023';
      end if;
    end loop;
    if (day_value->>'rowCount')::integer not between 1 and 100000 then
      raise exception 'Número de filas no válido' using errcode = '22023';
    end if;
    select * into existing from public.imported_cash_closings
    where tenant_id = target_tenant and venue_id = p_venue_id and source = 'revo' and business_date = date_value;
    if found then
      if existing.cash_cents <> (day_value->>'cashCents')::integer
        or existing.card_cents <> (day_value->>'cardCents')::integer
        or existing.cash_tip_cents <> (day_value->>'cashTipCents')::integer
        or existing.card_tip_cents <> (day_value->>'cardTipCents')::integer then
        raise exception 'El día % ya está importado con otros importes. No se ha guardado ningún cambio; revisa el período del CSV.', date_value using errcode = '22023';
      end if;
      skipped_count := skipped_count + 1;
    else
      insert into public.imported_cash_closings (
        tenant_id, venue_id, business_date, cash_cents, card_cents, cash_tip_cents, card_tip_cents,
        source_row_count, file_name, imported_by
      ) values (
        target_tenant, p_venue_id, date_value, (day_value->>'cashCents')::integer, (day_value->>'cardCents')::integer,
        (day_value->>'cashTipCents')::integer, (day_value->>'cardTipCents')::integer,
        (day_value->>'rowCount')::integer, btrim(p_file_name), auth.uid()
      );
      inserted_count := inserted_count + 1;
    end if;
  end loop;
  return jsonb_build_object('inserted', inserted_count, 'skipped', skipped_count);
end;
$$;
revoke all on function public.import_revo_cash_closings(uuid, text, jsonb) from public, anon;
grant execute on function public.import_revo_cash_closings(uuid, text, jsonb) to authenticated;
