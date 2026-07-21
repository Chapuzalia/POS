begin;

alter table public.venues add column if not exists timezone text not null default 'Europe/Madrid';
alter table public.venues add column if not exists currency_code text not null default 'EUR';

alter table public.cash_sessions add column if not exists final_cash_fund_cents integer not null default 0 check (final_cash_fund_cents >= 0);
alter table public.cash_sessions add column if not exists print_snapshot jsonb;
alter table public.cash_sessions add column if not exists print_status text not null default 'not_requested'
  check (print_status in ('not_requested', 'pending', 'printed', 'failed', 'unknown'));
alter table public.cash_sessions add column if not exists print_job_id text;
alter table public.cash_sessions add column if not exists print_request_id text;
alter table public.cash_sessions add column if not exists printed_at timestamptz;
alter table public.cash_sessions add column if not exists print_error_code text;
alter table public.cash_sessions add column if not exists print_attempts integer not null default 0 check (print_attempts >= 0);
alter table public.cash_sessions add column if not exists print_copies integer not null default 0 check (print_copies >= 0);

create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  direction text not null check (direction in ('entry', 'exit')),
  amount_cents integer not null check (amount_cents > 0),
  category text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists cash_movements_session_idx on public.cash_movements (cash_session_id, created_at);
alter table public.cash_movements enable row level security;
drop policy if exists "cash_movements_select" on public.cash_movements;
create policy "cash_movements_select" on public.cash_movements for select to authenticated using (
  public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id)
);
drop policy if exists "cash_movements_insert" on public.cash_movements;
create policy "cash_movements_insert" on public.cash_movements for insert to authenticated with check (
  created_by = auth.uid() and public.user_has_venue_access(tenant_id, venue_id)
);

create table if not exists public.cash_closing_print_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  cash_closing_id uuid not null references public.cash_sessions(id) on delete restrict,
  event_type text not null check (event_type in ('cash_closing.printed', 'cash_closing.print_failed', 'cash_closing.reprinted')),
  user_id uuid not null references auth.users(id) on delete restrict,
  terminal_id uuid references public.devices(id) on delete set null,
  printer_id text,
  print_job_id text,
  request_id text not null,
  is_reprint boolean not null,
  copy_number integer not null default 0,
  error_code text,
  created_at timestamptz not null default now()
);

alter table public.cash_closing_print_events enable row level security;
drop policy if exists "cash_closing_print_events_select" on public.cash_closing_print_events;
create policy "cash_closing_print_events_select" on public.cash_closing_print_events for select to authenticated using (
  public.user_is_tenant_admin(tenant_id) or exists (
    select 1 from public.cash_sessions cs where cs.id = cash_closing_id
      and public.user_has_venue_access(cs.tenant_id, cs.venue_id)
  )
);

drop function if exists public.close_cash_register_session(uuid, uuid, jsonb);
create function public.close_cash_register_session(
  p_cash_session_id uuid,
  p_device_id uuid,
  p_payload jsonb
)
returns jsonb
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
  payments_json jsonb := '[]'::jsonb;
  entries_total integer := 0;
  exits_total integer := 0;
  snapshot jsonb;
begin
  select cs.* into session_row from public.cash_sessions cs where cs.id = p_cash_session_id for update;
  select d.* into device_row from public.devices d where d.id = p_device_id;
  if session_row.id is null or session_row.status <> 'open' then raise exception 'Caja no disponible'; end if;
  if device_row.id is null or device_row.tenant_id <> session_row.tenant_id or device_row.venue_id <> session_row.venue_id
    or not public.user_has_device_access(device_row.tenant_id, device_row.venue_id, device_row.id)
    or not device_row.can_close_cash_session then
    raise exception 'El dispositivo no puede cerrar esta caja' using errcode = '42501';
  end if;
  if exists (select 1 from public.orders o where o.cash_session_id = session_row.id and o.status = 'open') then
    raise exception 'No se puede cerrar la caja mientras existan comandas abiertas';
  end if;
  if coalesce((p_payload ->> 'finalCashFundCents')::integer, 0) < 0 then
    raise exception 'Fondo final no valido';
  end if;

  select v.* into venue_row from public.venues v where v.id = session_row.venue_id;
  select cr.name into register_name from public.cash_registers cr where cr.id = session_row.cash_register_id;
  select coalesce(p.full_name, 'Usuario') into opened_by_name from public.profiles p where p.id = session_row.opened_by;
  select coalesce(p.full_name, 'Usuario') into closed_by_name from public.profiles p where p.id = auth.uid();

  select coalesce(sum(s.total_cents), 0)::integer, count(*)::integer
    into sales_total, sales_count
  from public.sales s join public.tickets t on t.id = s.ticket_id
  where s.cash_session_id = session_row.id and t.status = 'paid';

  select coalesce(jsonb_agg(jsonb_build_object(
    'code', grouped.method,
    'label', case grouped.method when 'cash' then 'Efectivo' when 'card' then 'Tarjeta'
      when 'invitation' then 'Invitacion' when 'other' then 'Otros' else grouped.method end,
    'amountCents', grouped.amount_cents
  ) order by case grouped.method when 'cash' then 1 when 'card' then 2 when 'invitation' then 7 else 8 end), '[]'::jsonb)
  into payments_json
  from (
    select sp.method, sum(sp.amount_cents)::integer as amount_cents
    from public.sale_payments sp join public.sales s on s.id = sp.sale_id join public.tickets t on t.id = s.ticket_id
    where s.cash_session_id = session_row.id and t.status = 'paid'
    group by sp.method
  ) grouped;

  select
    coalesce(sum(cm.amount_cents) filter (where cm.direction = 'entry'), 0)::integer,
    coalesce(sum(cm.amount_cents) filter (where cm.direction = 'exit'), 0)::integer
  into entries_total, exits_total from public.cash_movements cm where cm.cash_session_id = session_row.id;

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
    'cashMovements', jsonb_build_object('entriesCents', entries_total, 'exitsCents', exits_total),
    'cashFund', jsonb_build_object(
      'openingCashFundCents', session_row.opening_float_cents,
      'finalCashFundCents', coalesce((p_payload ->> 'finalCashFundCents')::integer, 0)
    ),
    'expectedAndCounted', jsonb_build_object(
      'expectedCashCents', (p_payload ->> 'expectedCashCents')::integer,
      'countedCashCents', (p_payload ->> 'countedCashCents')::integer,
      'expectedCardCents', (p_payload ->> 'expectedCardCents')::integer,
      'countedCardCents', (p_payload ->> 'countedCardCents')::integer
    ),
    'differences', jsonb_build_object(
      'cashDifferenceCents', (p_payload ->> 'countedCashCents')::integer - (p_payload ->> 'expectedCashCents')::integer,
      'cardDifferenceCents', (p_payload ->> 'countedCardCents')::integer - (p_payload ->> 'expectedCardCents')::integer
    )
  );

  update public.cash_sessions as cs set
    status = 'closed', closed_at = closed_time, closed_by = auth.uid(), closed_by_device_id = device_row.id,
    expected_cash_cents = (p_payload ->> 'expectedCashCents')::integer,
    expected_card_cents = (p_payload ->> 'expectedCardCents')::integer,
    expected_invitation_cents = (p_payload ->> 'expectedInvitationCents')::integer,
    expected_other_cents = (p_payload ->> 'expectedOtherCents')::integer,
    counted_cash_cents = (p_payload ->> 'countedCashCents')::integer,
    counted_card_cents = (p_payload ->> 'countedCardCents')::integer,
    counted_invitation_cents = (p_payload ->> 'countedInvitationCents')::integer,
    counted_other_cents = (p_payload ->> 'countedOtherCents')::integer,
    discrepancy_cents = (p_payload ->> 'discrepancyCents')::integer,
    final_cash_fund_cents = coalesce((p_payload ->> 'finalCashFundCents')::integer, 0),
    notes = nullif(p_payload ->> 'notes', ''), print_snapshot = snapshot
  where cs.id = session_row.id;
  return jsonb_build_object('id', session_row.id, 'printSnapshot', snapshot);
end;
$$;

create or replace function public.record_cash_closing_print_result(
  p_cash_closing_id uuid,
  p_terminal_id uuid,
  p_printer_id text,
  p_print_job_id text,
  p_request_id text,
  p_status text,
  p_error_code text,
  p_is_reprint boolean,
  p_copy_number integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  closing public.cash_sessions%rowtype;
  event_name text;
  member_role text;
  terminal_can_manage_cash boolean := false;
begin
  select * into closing from public.cash_sessions where id = p_cash_closing_id for update;
  if closing.id is null or closing.status <> 'closed' or not public.user_has_venue_access(closing.tenant_id, closing.venue_id) then
    raise exception 'Cierre no disponible' using errcode = '42501';
  end if;
  if p_is_reprint then
    select tm.role into member_role from public.tenant_memberships tm
    where tm.tenant_id = closing.tenant_id and tm.user_id = auth.uid() and tm.is_active limit 1;
    select coalesce(d.can_manage_cash, false) into terminal_can_manage_cash from public.devices d
    where d.id = p_terminal_id and d.tenant_id = closing.tenant_id and d.venue_id = closing.venue_id;
    if coalesce(member_role, '') not in ('owner', 'admin', 'manager') and not terminal_can_manage_cash then
      raise exception 'No tienes permiso para reimprimir cierres' using errcode = '42501';
    end if;
  elsif closing.closed_by <> auth.uid() and not public.user_is_tenant_admin(closing.tenant_id) then
    raise exception 'No tienes permiso para imprimir este cierre' using errcode = '42501';
  end if;
  if p_status not in ('pending', 'printed', 'failed', 'unknown') then raise exception 'Estado de impresion no valido'; end if;
  if p_status = 'pending' and not p_is_reprint and closing.print_status in ('pending', 'printed', 'unknown') then
    return false;
  end if;
  if p_status = 'pending' and p_is_reprint and (
    (closing.print_request_id = p_request_id and closing.print_status in ('pending', 'printed', 'unknown'))
    or p_copy_number <= closing.print_copies
  ) then
    return false;
  end if;

  update public.cash_sessions set
    print_status = p_status,
    print_job_id = coalesce(p_print_job_id, print_job_id),
    print_request_id = p_request_id,
    printed_at = case when p_status = 'printed' then now() else printed_at end,
    print_error_code = p_error_code,
    print_attempts = print_attempts + case when p_status = 'pending' then 1 else 0 end,
    print_copies = print_copies + case when p_status = 'printed' and p_is_reprint then 1 else 0 end
  where id = closing.id;

  if p_status <> 'pending' then
    event_name := case when p_status = 'printed' and p_is_reprint then 'cash_closing.reprinted'
      when p_status = 'printed' then 'cash_closing.printed' else 'cash_closing.print_failed' end;
    insert into public.cash_closing_print_events (
      tenant_id, cash_closing_id, event_type, user_id, terminal_id, printer_id,
      print_job_id, request_id, is_reprint, copy_number, error_code
    ) values (
      closing.tenant_id, closing.id, event_name, auth.uid(), p_terminal_id, p_printer_id,
      p_print_job_id, p_request_id, p_is_reprint, p_copy_number, p_error_code
    );
  end if;
  return true;
end;
$$;

revoke all on function public.close_cash_register_session(uuid, uuid, jsonb) from public;
grant execute on function public.close_cash_register_session(uuid, uuid, jsonb) to authenticated;
revoke all on function public.record_cash_closing_print_result(uuid, uuid, text, text, text, text, text, boolean, integer) from public;
grant execute on function public.record_cash_closing_print_result(uuid, uuid, text, text, text, text, text, boolean, integer) to authenticated;

commit;
