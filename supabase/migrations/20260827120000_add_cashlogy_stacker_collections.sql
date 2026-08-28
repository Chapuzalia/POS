-- Persist completed Cashlogy stacker removals separately from manual cash movements.

create table if not exists public.cash_session_stacker_collections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  device_id uuid not null references public.devices(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  request_id text not null check (nullif(btrim(request_id), '') is not null),
  operation_id text not null check (nullif(btrim(operation_id), '') is not null),
  amount_cents integer not null check (amount_cents >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, request_id),
  unique (tenant_id, operation_id)
);

create index if not exists cash_session_stacker_collections_session_idx
  on public.cash_session_stacker_collections (cash_session_id, created_at);

alter table public.cash_session_stacker_collections enable row level security;

drop policy if exists cash_session_stacker_collections_select on public.cash_session_stacker_collections;
create policy cash_session_stacker_collections_select
on public.cash_session_stacker_collections
for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

revoke all on table public.cash_session_stacker_collections from anon, authenticated;
grant select on table public.cash_session_stacker_collections to authenticated;

create or replace function public.record_cashlogy_stacker_collection(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_request_id text,
  p_operation_id text,
  p_amount_cents integer
) returns public.cash_session_stacker_collections
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  collection_row public.cash_session_stacker_collections%rowtype;
  member_role text;
begin
  if auth.uid() is null then
    raise exception 'Autenticacion requerida' using errcode = '42501';
  end if;
  if p_request_id is null or nullif(btrim(p_request_id), '') is null then
    raise exception 'El requestId de Cashlogy es obligatorio';
  end if;
  if p_operation_id is null or nullif(btrim(p_operation_id), '') is null then
    raise exception 'El operationId de Cashlogy es obligatorio';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'El importe retirado del stacker no es valido';
  end if;

  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = p_cash_session_id
  for update;

  if session_row.id is null then
    raise exception 'Caja no disponible';
  end if;

  select d.* into device_row
  from public.devices d
  where d.id = p_device_id;

  select tm.role into member_role
  from public.tenant_memberships tm
  where tm.tenant_id = session_row.tenant_id
    and tm.user_id = auth.uid()
    and tm.is_active
  limit 1;

  if device_row.id is null
    or not device_row.is_active
    or device_row.tenant_id <> session_row.tenant_id
    or device_row.venue_id <> session_row.venue_id then
    raise exception 'El dispositivo no pertenece a esta caja' using errcode = '42501';
  end if;
  if coalesce(member_role, '') not in ('manager', 'owner')
    and (not public.user_has_device_access(session_row.tenant_id, session_row.venue_id, device_row.id)
      or not public.user_has_venue_access(session_row.tenant_id, session_row.venue_id)) then
    raise exception 'El usuario no tiene acceso al dispositivo o al local' using errcode = '42501';
  end if;
  if not coalesce(device_row.can_manage_cash, false)
    and coalesce(member_role, '') not in ('manager', 'owner') then
    raise exception 'No tienes permiso para retirar el stacker' using errcode = '42501';
  end if;

  select sc.* into collection_row
  from public.cash_session_stacker_collections sc
  where sc.tenant_id = session_row.tenant_id
    and (sc.request_id = btrim(p_request_id) or sc.operation_id = btrim(p_operation_id))
  limit 1;

  if collection_row.id is not null then
    if collection_row.cash_session_id <> session_row.id
      or collection_row.request_id <> btrim(p_request_id)
      or collection_row.operation_id <> btrim(p_operation_id)
      or collection_row.amount_cents <> p_amount_cents then
      raise exception 'La identidad de la retirada de stacker entra en conflicto con un registro existente' using errcode = '23505';
    end if;
    return collection_row;
  end if;

  if session_row.status <> 'open' then
    raise exception 'No se puede registrar una retirada de stacker en una caja cerrada' using errcode = '55000';
  end if;
  if device_row.active_cash_session_id is distinct from session_row.id then
    raise exception 'El dispositivo no esta vinculado a esta caja' using errcode = '42501';
  end if;

  insert into public.cash_session_stacker_collections (
    tenant_id, venue_id, cash_session_id, device_id, created_by,
    request_id, operation_id, amount_cents
  ) values (
    session_row.tenant_id, session_row.venue_id, session_row.id, device_row.id, auth.uid(),
    btrim(p_request_id), btrim(p_operation_id), p_amount_cents
  )
  on conflict do nothing
  returning * into collection_row;

  if collection_row.id is null then
    select sc.* into collection_row
    from public.cash_session_stacker_collections sc
    where sc.tenant_id = session_row.tenant_id
      and (sc.request_id = btrim(p_request_id) or sc.operation_id = btrim(p_operation_id))
    limit 1;
  end if;

  if collection_row.id is null
    or collection_row.cash_session_id <> session_row.id
    or collection_row.request_id <> btrim(p_request_id)
    or collection_row.operation_id <> btrim(p_operation_id)
    or collection_row.amount_cents <> p_amount_cents then
    raise exception 'La identidad de la retirada de stacker entra en conflicto con un registro existente' using errcode = '23505';
  end if;

  return collection_row;
end;
$$;

revoke all on function public.record_cashlogy_stacker_collection(uuid, uuid, text, text, integer) from public;
grant execute on function public.record_cashlogy_stacker_collection(uuid, uuid, text, text, integer) to authenticated;

create or replace function public.close_cash_register_session(p_cash_session_id uuid, p_device_id uuid, p_payload jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.cash_sessions%rowtype;
  device_row public.devices%rowtype;
  venue_row public.venues%rowtype;
  register_name text;
  opened_by_name text;
  closed_by_name text;
  closed_time timestamptz := now();
  sales_total integer := 0;
  sales_count integer := 0;
  cash_payments_total integer := 0;
  card_payments_total integer := 0;
  invitation_payments_total integer := 0;
  other_payments_total integer := 0;
  cash_entries_total integer := 0;
  cash_exits_total integer := 0;
  card_cashback_total integer := 0;
  stacker_collections_total integer := 0;
  expected_cash_total integer := 0;
  expected_card_total integer := 0;
  counted_cash_total integer := 0;
  counted_card_total integer := 0;
  counted_invitation_total integer := 0;
  counted_other_total integer := 0;
  final_cash_fund_total integer := 0;
  payments_json jsonb := '[]'::jsonb;
  snapshot jsonb;
begin
  if auth.uid() is null then
    raise exception 'Autenticacion requerida' using errcode = '42501';
  end if;

  select cs.* into session_row
  from public.cash_sessions cs
  where cs.id = p_cash_session_id
  for update;
  select d.* into device_row from public.devices d where d.id = p_device_id;

  if session_row.id is null or session_row.status <> 'open' then
    raise exception 'Caja no disponible';
  end if;
  if device_row.id is null
    or not device_row.is_active
    or device_row.tenant_id <> session_row.tenant_id
    or device_row.venue_id <> session_row.venue_id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not device_row.can_close_cash_session then
    raise exception 'El dispositivo no puede cerrar esta caja' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.orders o
    where o.cash_session_id = session_row.id and o.status = 'open'
  ) then
    raise exception 'No se puede cerrar la caja mientras existan comandas abiertas';
  end if;

  final_cash_fund_total := coalesce((p_payload ->> 'finalCashFundCents')::integer, 0);
  counted_cash_total := coalesce((p_payload ->> 'countedCashCents')::integer, 0);
  counted_card_total := coalesce((p_payload ->> 'countedCardCents')::integer, 0);
  counted_invitation_total := coalesce((p_payload ->> 'countedInvitationCents')::integer, 0);
  counted_other_total := coalesce((p_payload ->> 'countedOtherCents')::integer, 0);
  if final_cash_fund_total < 0 then
    raise exception 'Fondo final no valido';
  end if;

  select v.* into venue_row from public.venues v where v.id = session_row.venue_id;
  select cr.name into register_name from public.cash_registers cr where cr.id = session_row.cash_register_id;
  select coalesce(p.full_name, 'Usuario') into opened_by_name from public.profiles p where p.id = session_row.opened_by;
  select coalesce(p.full_name, 'Usuario') into closed_by_name from public.profiles p where p.id = auth.uid();

  select coalesce(sum(s.total_cents), 0)::integer, count(*)::integer
    into sales_total, sales_count
  from public.sales s
  join public.tickets t on t.id = s.ticket_id
  where s.cash_session_id = session_row.id
    and t.status = 'paid';

  select
    coalesce(sum(sp.amount_cents) filter (where sp.method = 'cash'), 0)::integer,
    coalesce(sum(sp.amount_cents) filter (where sp.method = 'card'), 0)::integer,
    coalesce(sum(sp.amount_cents) filter (where sp.method = 'invitation'), 0)::integer,
    coalesce(sum(sp.amount_cents) filter (where sp.method not in ('cash', 'card', 'invitation')), 0)::integer
  into cash_payments_total, card_payments_total, invitation_payments_total, other_payments_total
  from public.sale_payments sp
  join public.sales s on s.id = sp.sale_id
  join public.tickets t on t.id = s.ticket_id
  where s.cash_session_id = session_row.id
    and t.status = 'paid';

  select coalesce(jsonb_agg(jsonb_build_object(
    'code', grouped.method,
    'label', case grouped.method
      when 'cash' then 'Efectivo'
      when 'card' then 'Tarjeta'
      when 'invitation' then 'Invitacion'
      when 'other' then 'Otros'
      else grouped.method
    end,
    'amountCents', grouped.amount_cents
  ) order by case grouped.method when 'cash' then 1 when 'card' then 2 when 'invitation' then 7 else 8 end), '[]'::jsonb)
  into payments_json
  from (
    select sp.method, sum(sp.amount_cents)::integer as amount_cents
    from public.sale_payments sp
    join public.sales s on s.id = sp.sale_id
    join public.tickets t on t.id = s.ticket_id
    where s.cash_session_id = session_row.id
      and t.status = 'paid'
    group by sp.method
  ) grouped;

  select
    coalesce(sum(cm.amount_cents) filter (
      where cm.category = 'cash_in'
        or (cm.direction = 'entry' and (cm.category is null or cm.category not in ('cash_in', 'cash_out', 'card_cashback')))
    ), 0)::integer,
    coalesce(sum(cm.amount_cents) filter (
      where cm.category = 'cash_out'
        or (cm.direction = 'exit' and (cm.category is null or cm.category not in ('cash_in', 'cash_out', 'card_cashback')))
    ), 0)::integer,
    coalesce(sum(cm.amount_cents) filter (where cm.category = 'card_cashback'), 0)::integer
  into cash_entries_total, cash_exits_total, card_cashback_total
  from public.cash_movements cm
  where cm.cash_session_id = session_row.id;

  select coalesce(sum(sc.amount_cents), 0)::integer
  into stacker_collections_total
  from public.cash_session_stacker_collections sc
  where sc.cash_session_id = session_row.id;

  expected_cash_total := session_row.opening_float_cents
    + cash_payments_total
    + cash_entries_total
    - cash_exits_total
    - card_cashback_total
    - stacker_collections_total;
  expected_card_total := card_payments_total + card_cashback_total;

  snapshot := jsonb_build_object(
    'reportTitle', 'Informe ' || upper(substr(session_row.id::text, 1, 8)),
    'companyName', venue_row.name,
    'registerName', coalesce(register_name, 'Caja'),
    'shiftLabel', upper(substr(session_row.id::text, 1, 8)),
    'openedAt', session_row.opened_at,
    'closedAt', closed_time,
    'timezone', coalesce(venue_row.timezone, 'Europe/Madrid'),
    'currency', coalesce(venue_row.currency_code, 'EUR'),
    'locale', 'es-ES',
    'openedBy', coalesce(opened_by_name, 'Usuario'),
    'closedBy', coalesce(closed_by_name, 'Usuario'),
    'summary', jsonb_build_object(
      'totalSalesCents', sales_total,
      'salesCount', sales_count,
      'averageSaleCents', case when sales_count = 0 then 0 else round(sales_total::numeric / sales_count)::integer end
    ),
    'payments', payments_json,
    'cashMovements', jsonb_build_object(
      'cashEntriesCents', cash_entries_total,
      'cashExitsCents', cash_exits_total,
      'cardCashbackCents', card_cashback_total,
      'stackerCollectionsCents', stacker_collections_total
    ),
    'cashFund', jsonb_build_object(
      'openingCashFundCents', session_row.opening_float_cents,
      'finalCashFundCents', final_cash_fund_total
    ),
    'expectedAndCounted', jsonb_build_object(
      'expectedCashCents', expected_cash_total,
      'countedCashCents', counted_cash_total,
      'expectedCardCents', expected_card_total,
      'countedCardCents', counted_card_total
    ),
    'differences', jsonb_build_object(
      'cashDifferenceCents', counted_cash_total - expected_cash_total,
      'cardDifferenceCents', counted_card_total - expected_card_total
    )
  );

  update public.cash_sessions as cs set
    status = 'closed',
    closed_at = closed_time,
    closed_by = auth.uid(),
    closed_by_device_id = device_row.id,
    expected_cash_cents = expected_cash_total,
    expected_card_cents = expected_card_total,
    expected_invitation_cents = invitation_payments_total,
    expected_other_cents = other_payments_total,
    counted_cash_cents = counted_cash_total,
    counted_card_cents = counted_card_total,
    counted_invitation_cents = counted_invitation_total,
    counted_other_cents = counted_other_total,
    discrepancy_cents = (counted_cash_total - expected_cash_total)
      + (counted_card_total - expected_card_total)
      + (counted_invitation_total - invitation_payments_total)
      + (counted_other_total - other_payments_total),
    final_cash_fund_cents = final_cash_fund_total,
    notes = nullif(btrim(p_payload ->> 'notes'), ''),
    print_snapshot = snapshot
  where cs.id = session_row.id;

  return jsonb_build_object('id', session_row.id, 'printSnapshot', snapshot);
end;
$$;
