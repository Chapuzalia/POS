-- Cobro persistente de una comanda a partes iguales. Cada parte genera su
-- propio ticket y venta, mientras la ocupacion permanece abierta hasta la ultima.

begin;

alter table public.ticket_lines
  add column if not exists allocated_quantity numeric(18, 9);
alter table public.ticket_lines drop constraint if exists ticket_lines_allocated_quantity_check;
alter table public.ticket_lines add constraint ticket_lines_allocated_quantity_check
  check (allocated_quantity is null or allocated_quantity > 0);

create table if not exists public.restaurant_order_equal_splits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  order_group_id uuid not null,
  order_id uuid not null,
  total_cents integer not null check (total_cents > 0),
  part_count integer not null check (part_count between 2 and 99),
  paid_parts integer not null default 0 check (paid_parts >= 0),
  paid_cents integer not null default 0 check (paid_cents >= 0),
  allow_pending_service boolean not null default false,
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint restaurant_order_equal_splits_order_unique unique (order_id),
  constraint restaurant_order_equal_splits_id_scope_unique unique (id, tenant_id, venue_id),
  constraint restaurant_order_equal_splits_group_fk foreign key (order_group_id, tenant_id, venue_id)
    references public.order_groups(id, tenant_id, venue_id) on delete restrict,
  constraint restaurant_order_equal_splits_order_fk foreign key (order_id, tenant_id, venue_id)
    references public.orders(id, tenant_id, venue_id) on delete restrict,
  constraint restaurant_order_equal_splits_progress_check check (
    paid_parts <= part_count and paid_cents <= total_cents
    and ((status = 'completed' and paid_parts = part_count and paid_cents = total_cents and completed_at is not null)
      or (status <> 'completed' and completed_at is null))
  )
);

create index if not exists restaurant_order_equal_splits_open_group_idx
  on public.restaurant_order_equal_splits(order_group_id) where status = 'open';

create table if not exists public.restaurant_order_equal_split_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete restrict,
  split_id uuid not null,
  part_number integer not null check (part_number > 0),
  amount_cents integer not null check (amount_cents > 0),
  payment_method text not null check (payment_method in ('cash', 'card')),
  received_cents integer,
  change_cents integer not null default 0 check (change_cents >= 0),
  ticket_id uuid not null references public.tickets(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint restaurant_order_equal_split_payments_split_fk foreign key (split_id, tenant_id, venue_id)
    references public.restaurant_order_equal_splits(id, tenant_id, venue_id) on delete restrict,
  constraint restaurant_order_equal_split_payment_part_unique unique (split_id, part_number)
);

alter table public.tickets add column if not exists equal_split_id uuid;
alter table public.tickets add column if not exists equal_split_part_number integer;
alter table public.tickets drop constraint if exists tickets_equal_split_fk;
alter table public.tickets add constraint tickets_equal_split_fk
  foreign key (equal_split_id) references public.restaurant_order_equal_splits(id) on delete set null;
alter table public.tickets drop constraint if exists tickets_equal_split_snapshot_check;
alter table public.tickets add constraint tickets_equal_split_snapshot_check check (
  (equal_split_id is null and equal_split_part_number is null)
  or (equal_split_id is not null and equal_split_part_number > 0)
);
create unique index if not exists tickets_equal_split_part_unique
  on public.tickets(equal_split_id, equal_split_part_number) where equal_split_id is not null;

alter table public.order_events drop constraint if exists order_events_event_type_check;
alter table public.order_events add constraint order_events_event_type_check check (event_type in (
  'order_opened', 'order_moved', 'tables_grouped', 'line_added',
  'line_quantity_changed', 'line_partially_served', 'line_fully_served',
  'order_fully_served', 'order_paid', 'order_cancelled',
  'order_split_created', 'line_moved', 'order_split_removed',
  'equal_split_started', 'equal_split_part_paid', 'equal_split_completed'
));

alter table public.restaurant_order_equal_splits enable row level security;
alter table public.restaurant_order_equal_split_payments enable row level security;
drop policy if exists "restaurant_order_equal_splits_select" on public.restaurant_order_equal_splits;
create policy "restaurant_order_equal_splits_select" on public.restaurant_order_equal_splits
for select to authenticated using (
  public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id)
);
drop policy if exists "restaurant_order_equal_split_payments_select" on public.restaurant_order_equal_split_payments;
create policy "restaurant_order_equal_split_payments_select" on public.restaurant_order_equal_split_payments
for select to authenticated using (
  public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id)
);
grant select on public.restaurant_order_equal_splits, public.restaurant_order_equal_split_payments to authenticated;

create or replace function public.restaurant_equal_split_to_json(p_split public.restaurant_order_equal_splits)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_split.id,
    'orderId', p_split.order_id,
    'orderGroupId', p_split.order_group_id,
    'totalCents', p_split.total_cents,
    'partCount', p_split.part_count,
    'paidParts', p_split.paid_parts,
    'paidCents', p_split.paid_cents,
    'remainingParts', p_split.part_count - p_split.paid_parts,
    'remainingCents', p_split.total_cents - p_split.paid_cents,
    'nextPartCents', case when p_split.status = 'open' then
      (p_split.total_cents / p_split.part_count)
      + case when p_split.paid_parts + 1 <= mod(p_split.total_cents, p_split.part_count) then 1 else 0 end
      else 0 end,
    'status', p_split.status,
    'revision', p_split.revision,
    'allowPendingService', p_split.allow_pending_service
  );
$$;

create or replace function public.configure_restaurant_order_equal_split(
  p_order_id uuid,
  p_part_count integer,
  p_expected_order_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  order_row public.orders%rowtype;
  split_row public.restaurant_order_equal_splits%rowtype;
  order_total integer;
begin
  if p_part_count < 2 or p_part_count > 99 then
    raise exception 'El numero de comensales debe estar entre 2 y 99' using errcode = '22023';
  end if;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.id is null or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Comanda no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_groups og where og.id = order_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = order_row.order_group_id order by o.id for update;
  select o.* into order_row from public.orders o where o.id = p_order_id;
  if order_row.status <> 'open' or order_row.revision <> p_expected_order_revision then
    raise exception 'La comanda ha cambiado en otro dispositivo' using errcode = '40001';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.id for update;
  select coalesce(sum(ol.quantity * ol.unit_price_cents), 0)::integer into order_total
  from public.order_lines ol where ol.order_id = order_row.id;
  if order_total <= 0 then raise exception 'No se puede dividir una comanda vacia'; end if;
  if p_part_count > order_total then raise exception 'El numero de partes supera los centimos cobrables' using errcode = '22023'; end if;

  select s.* into split_row from public.restaurant_order_equal_splits s
  where s.order_id = order_row.id for update;
  if split_row.id is not null and split_row.status = 'completed' then
    raise exception 'Esta comanda ya se cobro por completo';
  end if;
  if split_row.id is not null and split_row.paid_parts > 0 then
    if split_row.part_count <> p_part_count or split_row.total_cents <> order_total then
      raise exception 'No se puede cambiar el reparto despues del primer cobro' using errcode = '55000';
    end if;
    return public.restaurant_equal_split_to_json(split_row);
  end if;

  insert into public.restaurant_order_equal_splits (
    tenant_id, venue_id, order_group_id, order_id, total_cents, part_count, status
  ) values (
    order_row.tenant_id, order_row.venue_id, order_row.order_group_id, order_row.id,
    order_total, p_part_count, 'open'
  )
  on conflict (order_id) do update set
    total_cents = excluded.total_cents,
    part_count = excluded.part_count,
    paid_parts = 0,
    paid_cents = 0,
    allow_pending_service = false,
    status = 'open',
    revision = public.restaurant_order_equal_splits.revision + 1,
    updated_at = now(),
    completed_at = null
  returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_started', jsonb_build_object(
    'splitId', split_row.id, 'partCount', split_row.part_count, 'totalCents', split_row.total_cents
  ));
  return public.restaurant_equal_split_to_json(split_row);
end;
$$;

create or replace function public.pay_restaurant_order_equal_part(
  p_split_id uuid,
  p_payment_method text,
  p_received_cents integer default null,
  p_allow_pending boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  split_row public.restaurant_order_equal_splits%rowtype;
  order_row public.orders%rowtype;
  session_row public.cash_sessions%rowtype;
  actor_device public.devices%rowtype;
  line_row public.order_lines%rowtype;
  part_number integer;
  part_amount integer;
  base_amount integer;
  remainder integer;
  part_start integer;
  part_end integer;
  line_start integer := 0;
  line_end integer;
  allocated_cents integer;
  allocated_quantity numeric;
  pending_units integer;
  ticket_id uuid := gen_random_uuid();
  sale_id uuid := gen_random_uuid();
  payment_id uuid := gen_random_uuid();
  remaining_orders integer;
  next_order_id uuid;
begin
  if p_payment_method not in ('cash', 'card') then raise exception 'Metodo de pago no valido'; end if;
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id;
  if split_row.id is null or split_row.status <> 'open' then raise exception 'Division no disponible'; end if;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  perform 1 from public.order_groups og where og.id = split_row.order_group_id for update;
  perform 1 from public.orders o where o.order_group_id = split_row.order_group_id order by o.id for update;
  select s.* into split_row from public.restaurant_order_equal_splits s where s.id = p_split_id for update;
  select o.* into order_row from public.orders o where o.id = split_row.order_id;
  if split_row.status <> 'open' or order_row.status <> 'open'
    or not public.user_has_venue_access(order_row.tenant_id, order_row.venue_id) then
    raise exception 'Division no disponible' using errcode = '42501';
  end if;
  perform 1 from public.order_lines ol where ol.order_id = order_row.id order by ol.created_at, ol.id for update;
  select coalesce(sum(ol.quantity - ol.served_quantity), 0)::integer into pending_units
  from public.order_lines ol where ol.order_id = order_row.id;
  if pending_units > 0 and not split_row.allow_pending_service and not p_allow_pending then
    return jsonb_build_object('requiresConfirmation', true, 'pendingUnits', pending_units, 'split', public.restaurant_equal_split_to_json(split_row));
  end if;
  if p_allow_pending and not split_row.allow_pending_service then
    update public.restaurant_order_equal_splits set allow_pending_service = true where id = split_row.id
    returning * into split_row;
  end if;

  select cs.* into session_row from public.cash_sessions cs where cs.id = order_row.cash_session_id for update;
  select d.* into actor_device from public.devices d
  join public.device_user_assignments dua on dua.device_id = d.id
  where dua.user_id = auth.uid() and dua.tenant_id = order_row.tenant_id
    and dua.venue_id = order_row.venue_id and dua.is_active and d.is_active
    and d.can_take_payments
  order by case when d.id = order_row.opened_by_device_id then 0 else 1 end, d.id limit 1;
  if session_row.id is null or session_row.status <> 'open'
    or session_row.tenant_id <> order_row.tenant_id or session_row.venue_id <> order_row.venue_id
    or actor_device.id is null then
    raise exception 'La caja o el dispositivo de cobro no estan disponibles' using errcode = '42501';
  end if;

  base_amount := split_row.total_cents / split_row.part_count;
  remainder := mod(split_row.total_cents, split_row.part_count);
  part_number := split_row.paid_parts + 1;
  part_amount := base_amount + case when part_number <= remainder then 1 else 0 end;
  part_start := (part_number - 1) * base_amount + least(part_number - 1, remainder);
  part_end := part_start + part_amount;
  if p_payment_method = 'cash' and coalesce(p_received_cents, 0) < part_amount then
    raise exception 'Importe recibido insuficiente';
  end if;

  insert into public.tickets (
    id, tenant_id, cash_session_id, cash_register_id, venue_id, device_id, user_id,
    status, subtotal_cents, total_cents, local_created_at, equal_split_id, equal_split_part_number
  ) values (
    ticket_id, order_row.tenant_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), 'paid', part_amount, part_amount,
    now(), split_row.id, part_number
  );

  for line_row in select ol.* from public.order_lines ol
    where ol.order_id = order_row.id order by ol.created_at, ol.id
  loop
    line_end := line_start + line_row.quantity * line_row.unit_price_cents;
    allocated_cents := greatest(0, least(line_end, part_end) - greatest(line_start, part_start));
    if allocated_cents > 0 or (line_end = line_start and part_number = 1) then
      allocated_quantity := case when line_end = line_start then line_row.quantity::numeric
        else line_row.quantity::numeric * allocated_cents::numeric / (line_end - line_start)::numeric end;
      insert into public.ticket_lines (
        id, tenant_id, ticket_id, product_id, variant_id, product_name, variant_name,
        quantity, allocated_quantity, unit_price_cents, line_total_cents, modifiers
      ) values (
        gen_random_uuid(), line_row.tenant_id, ticket_id, line_row.product_id, line_row.variant_id,
        line_row.product_name, line_row.variant_name, 1, allocated_quantity,
        allocated_cents, allocated_cents,
        line_row.modifiers || case when line_row.mixer is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
          'id', 'mixer:' || line_row.mixer_product_id::text, 'groupId', 'mixer',
          'name', line_row.mixer ->> 'name', 'priceCents', (line_row.mixer ->> 'priceCents')::integer
        )) end
      );
    end if;
    line_start := line_end;
  end loop;

  insert into public.sales (
    id, tenant_id, ticket_id, cash_session_id, cash_register_id, venue_id,
    device_id, user_id, total_cents, payment_method, local_created_at
  ) values (
    sale_id, order_row.tenant_id, ticket_id, session_row.id, session_row.cash_register_id,
    order_row.venue_id, actor_device.id, auth.uid(), part_amount, p_payment_method, now()
  );
  insert into public.sale_payments (
    id, tenant_id, sale_id, method, amount_cents, received_cents, change_cents
  ) values (
    payment_id, order_row.tenant_id, sale_id, p_payment_method, part_amount,
    case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_amount else 0 end
  );
  insert into public.restaurant_order_equal_split_payments (
    tenant_id, venue_id, split_id, part_number, amount_cents, payment_method,
    received_cents, change_cents, ticket_id, sale_id
  ) values (
    order_row.tenant_id, order_row.venue_id, split_row.id, part_number, part_amount,
    p_payment_method, case when p_payment_method = 'cash' then p_received_cents else null end,
    case when p_payment_method = 'cash' then p_received_cents - part_amount else 0 end,
    ticket_id, sale_id
  );

  update public.restaurant_order_equal_splits s set
    paid_parts = s.paid_parts + 1,
    paid_cents = s.paid_cents + part_amount,
    status = case when s.paid_parts + 1 = s.part_count then 'completed' else 'open' end,
    completed_at = case when s.paid_parts + 1 = s.part_count then now() else null end,
    revision = s.revision + 1,
    updated_at = now()
  where s.id = split_row.id returning * into split_row;
  perform public.record_restaurant_order_event(order_row.id, 'equal_split_part_paid', jsonb_build_object(
    'splitId', split_row.id, 'partNumber', part_number, 'partCount', split_row.part_count,
    'amountCents', part_amount, 'ticketId', ticket_id, 'saleId', sale_id
  ));

  if split_row.status = 'completed' then
    perform set_config('app.equal_split_finalizing', split_row.id::text, true);
    update public.orders o set status = 'paid', closed_at = now(), updated_at = now()
    where o.id = order_row.id;
    select count(*) into remaining_orders from public.orders o
    where o.order_group_id = order_row.order_group_id and o.status = 'open';
    if remaining_orders = 0 then
      update public.order_groups set status = 'closed', closed_at = now(), updated_at = now()
      where id = order_row.order_group_id;
      update public.order_tables set released_at = now()
      where order_group_id = order_row.order_group_id and released_at is null;
    else
      select o.id into next_order_id from public.orders o
      where o.order_group_id = order_row.order_group_id and o.status = 'open'
      order by o.split_sequence limit 1;
    end if;
    perform public.record_restaurant_order_event(order_row.id, 'equal_split_completed', jsonb_build_object('splitId', split_row.id));
  end if;

  return jsonb_build_object(
    'requiresConfirmation', false,
    'pendingUnits', pending_units,
    'split', public.restaurant_equal_split_to_json(split_row),
    'ticketId', ticket_id,
    'saleId', sale_id,
    'paymentId', payment_id,
    'paidAmountCents', part_amount,
    'completed', split_row.status = 'completed',
    'nextOrderId', next_order_id
  );
end;
$$;

create or replace function public.guard_paid_equal_split_order_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare guarded_order_id uuid := case when tg_op = 'DELETE' then old.order_id else new.order_id end;
begin
  if not exists (
    select 1 from public.restaurant_order_equal_splits s
    where s.order_id = guarded_order_id and s.status = 'open' and s.paid_parts > 0
  ) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op <> 'UPDATE' or new.order_id is distinct from old.order_id
    or new.product_id is distinct from old.product_id or new.variant_id is distinct from old.variant_id
    or new.product_name is distinct from old.product_name or new.variant_name is distinct from old.variant_name
    or new.unit_price_cents is distinct from old.unit_price_cents or new.quantity is distinct from old.quantity
    or new.modifiers is distinct from old.modifiers or new.mixer_product_id is distinct from old.mixer_product_id
    or new.mixer is distinct from old.mixer or new.note is distinct from old.note then
    raise exception 'No se puede modificar una comanda con partes ya cobradas' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_paid_equal_split_order_lines on public.order_lines;
create trigger guard_paid_equal_split_order_lines
before insert or update or delete on public.order_lines
for each row execute function public.guard_paid_equal_split_order_lines();

create or replace function public.guard_equal_split_order_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare split_row public.restaurant_order_equal_splits%rowtype;
begin
  if old.status = 'open' and new.status in ('paid', 'cancelled') then
    select s.* into split_row from public.restaurant_order_equal_splits s
    where s.order_id = old.id and s.status = 'open' for update;
    if split_row.id is not null and split_row.paid_parts > 0
      and current_setting('app.equal_split_finalizing', true) is distinct from split_row.id::text then
      raise exception 'La comanda tiene un cobro a partes iguales en curso' using errcode = '55000';
    elsif split_row.id is not null and split_row.paid_parts = 0 then
      update public.restaurant_order_equal_splits set status = 'cancelled', revision = revision + 1, updated_at = now()
      where id = split_row.id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_equal_split_order_close on public.orders;
create trigger guard_equal_split_order_close
before update of status on public.orders
for each row execute function public.guard_equal_split_order_close();

revoke all on function public.restaurant_equal_split_to_json(public.restaurant_order_equal_splits) from public, anon, authenticated;
revoke all on function public.configure_restaurant_order_equal_split(uuid, integer, integer) from public;
revoke all on function public.pay_restaurant_order_equal_part(uuid, text, integer, boolean) from public;
revoke all on function public.guard_paid_equal_split_order_lines() from public, anon, authenticated;
revoke all on function public.guard_equal_split_order_close() from public, anon, authenticated;
grant execute on function public.configure_restaurant_order_equal_split(uuid, integer, integer) to authenticated;
grant execute on function public.pay_restaurant_order_equal_part(uuid, text, integer, boolean) to authenticated;

do $$
begin
  begin alter publication supabase_realtime add table public.restaurant_order_equal_splits; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.restaurant_order_equal_split_payments; exception when duplicate_object then null; end;
end $$;

commit;
