-- Accesos separados para administracion, locales y dispositivos TPV.
-- Ejecutar despues de pos-security-hardening-migration.sql.

begin;

create table if not exists public.device_user_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index if not exists device_user_assignments_user_idx
on public.device_user_assignments (user_id, tenant_id)
where is_active = true;

create unique index if not exists one_active_user_per_device
on public.device_user_assignments (tenant_id, device_id)
where is_active = true;

alter table public.device_user_assignments enable row level security;

create or replace function public.user_is_tenant_admin(target_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.role in ('owner', 'admin')
      and tm.is_active = true
  );
$$;

create or replace function public.user_has_device_access(
  target_tenant uuid,
  target_venue uuid,
  target_device uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.device_user_assignments dua
    join public.tenant_memberships tm
      on tm.tenant_id = dua.tenant_id
     and tm.user_id = dua.user_id
    where dua.tenant_id = target_tenant
      and dua.venue_id = target_venue
      and dua.device_id = target_device
      and dua.user_id = auth.uid()
      and dua.is_active = true
      and tm.is_active = true
      and tm.role = 'cashier'
  );
$$;

create or replace function public.user_can_view_device(
  target_tenant uuid,
  target_venue uuid,
  target_device uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.user_is_tenant_admin(target_tenant)
    or public.user_has_device_access(target_tenant, target_venue, target_device);
$$;

create or replace function public.validate_device_user_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.devices d
    where d.id = new.device_id
      and d.tenant_id = new.tenant_id
      and d.venue_id = new.venue_id
  ) then
    raise exception 'El dispositivo no pertenece al negocio y local indicados';
  end if;

  if not exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = new.tenant_id
      and tm.user_id = new.user_id
      and tm.role = 'cashier'
  ) then
    raise exception 'La asignacion requiere una membresia con rol cashier';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_device_user_assignment on public.device_user_assignments;
create trigger validate_device_user_assignment
before insert or update on public.device_user_assignments
for each row execute function public.validate_device_user_assignment();

drop trigger if exists set_device_user_assignments_updated_at on public.device_user_assignments;
create trigger set_device_user_assignments_updated_at
before update on public.device_user_assignments
for each row execute function public.set_updated_at();

revoke all on function public.user_is_tenant_admin(uuid) from public;
revoke all on function public.user_has_device_access(uuid, uuid, uuid) from public;
revoke all on function public.user_can_view_device(uuid, uuid, uuid) from public;
revoke all on function public.validate_device_user_assignment() from public;
grant execute on function public.user_is_tenant_admin(uuid) to authenticated;
grant execute on function public.user_has_device_access(uuid, uuid, uuid) to authenticated;
grant execute on function public.user_can_view_device(uuid, uuid, uuid) to authenticated;

drop policy if exists "device_assignments_select" on public.device_user_assignments;
drop policy if exists "device_assignments_admin_manage" on public.device_user_assignments;
create policy "device_assignments_select" on public.device_user_assignments
for select to authenticated
using (user_id = (select auth.uid()) or public.user_is_tenant_admin(tenant_id));
create policy "device_assignments_admin_manage" on public.device_user_assignments
for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

-- Los cajeros solo ven su local/dispositivo; administracion gestiona toda la estructura.
drop policy if exists "venues_tenant_access" on public.venues;
drop policy if exists "venues_select" on public.venues;
drop policy if exists "venues_admin_manage" on public.venues;
create policy "venues_select" on public.venues
for select to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or exists (
    select 1 from public.device_user_assignments dua
    where dua.tenant_id = venues.tenant_id
      and dua.venue_id = venues.id
      and dua.user_id = (select auth.uid())
      and dua.is_active = true
  )
);
create policy "venues_admin_manage" on public.venues
for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "devices_tenant_access" on public.devices;
drop policy if exists "devices_select" on public.devices;
drop policy if exists "devices_admin_manage" on public.devices;
create policy "devices_select" on public.devices
for select to authenticated
using (public.user_can_view_device(tenant_id, venue_id, id));
create policy "devices_admin_manage" on public.devices
for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

-- Catalogo legible para todos los miembros, modificable solo por administracion.
do $$
declare
  table_name text;
  old_policy text;
begin
  foreach table_name in array array[
    'categories', 'sale_formats', 'products', 'product_variants', 'modifier_groups', 'modifiers'
  ]
  loop
    old_policy := table_name || '_tenant_access';
    execute format('drop policy if exists %I on public.%I', old_policy, table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_select', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_admin_manage', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.user_has_tenant_access(tenant_id))',
      table_name || '_select', table_name
    );
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id))',
      table_name || '_admin_manage', table_name
    );
  end loop;
end $$;

-- Cajas y ventas: administracion ve todo; solo el usuario asignado escribe en su dispositivo.
drop policy if exists "cash_sessions_select" on public.cash_sessions;
drop policy if exists "cash_sessions_insert" on public.cash_sessions;
drop policy if exists "cash_sessions_update" on public.cash_sessions;
drop policy if exists "cash_sessions_delete" on public.cash_sessions;
create policy "cash_sessions_select" on public.cash_sessions for select to authenticated
using (public.user_can_view_device(tenant_id, venue_id, device_id));
create policy "cash_sessions_insert" on public.cash_sessions for insert to authenticated
with check (
  public.user_has_device_access(tenant_id, venue_id, device_id)
  and opened_by = (select auth.uid())
  and status = 'open'
  and closed_by is null
);
create policy "cash_sessions_update" on public.cash_sessions for update to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id))
with check (public.user_has_device_access(tenant_id, venue_id, device_id));

drop policy if exists "tickets_select" on public.tickets;
drop policy if exists "tickets_insert" on public.tickets;
drop policy if exists "tickets_update" on public.tickets;
drop policy if exists "tickets_delete" on public.tickets;
create policy "tickets_select" on public.tickets for select to authenticated
using (public.user_can_view_device(tenant_id, venue_id, device_id));
create policy "tickets_insert" on public.tickets for insert to authenticated
with check (
  public.user_has_device_access(tenant_id, venue_id, device_id)
  and user_id = (select auth.uid())
);
create policy "tickets_update" on public.tickets for update to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id))
with check (public.user_has_device_access(tenant_id, venue_id, device_id));
create policy "tickets_delete" on public.tickets for delete to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id));

drop policy if exists "sales_select" on public.sales;
drop policy if exists "sales_insert" on public.sales;
drop policy if exists "sales_update" on public.sales;
drop policy if exists "sales_delete" on public.sales;
create policy "sales_select" on public.sales for select to authenticated
using (public.user_can_view_device(tenant_id, venue_id, device_id));
create policy "sales_insert" on public.sales for insert to authenticated
with check (
  public.user_has_device_access(tenant_id, venue_id, device_id)
  and user_id = (select auth.uid())
);
create policy "sales_update" on public.sales for update to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id))
with check (public.user_has_device_access(tenant_id, venue_id, device_id));
create policy "sales_delete" on public.sales for delete to authenticated
using (public.user_has_device_access(tenant_id, venue_id, device_id));

drop policy if exists "ticket_lines_tenant_access" on public.ticket_lines;
drop policy if exists "ticket_lines_select" on public.ticket_lines;
drop policy if exists "ticket_lines_write" on public.ticket_lines;
create policy "ticket_lines_select" on public.ticket_lines for select to authenticated
using (exists (
  select 1 from public.tickets t
  where t.id = ticket_lines.ticket_id
    and public.user_can_view_device(t.tenant_id, t.venue_id, t.device_id)
));
create policy "ticket_lines_write" on public.ticket_lines for all to authenticated
using (exists (
  select 1 from public.tickets t
  where t.id = ticket_lines.ticket_id
    and public.user_has_device_access(t.tenant_id, t.venue_id, t.device_id)
))
with check (exists (
  select 1 from public.tickets t
  where t.id = ticket_lines.ticket_id
    and public.user_has_device_access(t.tenant_id, t.venue_id, t.device_id)
));

drop policy if exists "sale_payments_tenant_access" on public.sale_payments;
drop policy if exists "sale_payments_select" on public.sale_payments;
drop policy if exists "sale_payments_write" on public.sale_payments;
create policy "sale_payments_select" on public.sale_payments for select to authenticated
using (exists (
  select 1 from public.sales s
  where s.id = sale_payments.sale_id
    and public.user_can_view_device(s.tenant_id, s.venue_id, s.device_id)
));
create policy "sale_payments_write" on public.sale_payments for all to authenticated
using (exists (
  select 1 from public.sales s
  where s.id = sale_payments.sale_id
    and public.user_has_device_access(s.tenant_id, s.venue_id, s.device_id)
))
with check (exists (
  select 1 from public.sales s
  where s.id = sale_payments.sale_id
    and public.user_has_device_access(s.tenant_id, s.venue_id, s.device_id)
));

-- El log offline contiene payloads de venta; se limita al dispositivo asignado.
create or replace function public.user_can_access_offline_event(
  target_tenant uuid,
  event_kind_value text,
  event_payload jsonb,
  allow_admin boolean default true
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  event_device uuid;
  event_venue uuid;
  related_sale public.sales%rowtype;
  related_session public.cash_sessions%rowtype;
begin
  if allow_admin and public.user_is_tenant_admin(target_tenant) then
    return true;
  end if;

  if event_kind_value = 'sale_created' then
    event_device := (event_payload -> 'ticket' ->> 'deviceId')::uuid;
    event_venue := (event_payload -> 'ticket' ->> 'venueId')::uuid;
  elsif event_kind_value = 'cash_opened' then
    event_device := (event_payload -> 'session' ->> 'deviceId')::uuid;
    event_venue := (event_payload -> 'session' ->> 'venueId')::uuid;
  elsif event_kind_value = 'cash_closed' then
    select * into related_session from public.cash_sessions
    where id = (event_payload ->> 'sessionId')::uuid;
    event_device := related_session.device_id;
    event_venue := related_session.venue_id;
  elsif event_kind_value in ('sale_payment_changed', 'sale_voided') then
    select * into related_sale from public.sales
    where id = (event_payload ->> 'saleId')::uuid;
    event_device := related_sale.device_id;
    event_venue := related_sale.venue_id;
  end if;

  return event_device is not null
    and public.user_has_device_access(target_tenant, event_venue, event_device);
exception when others then
  return false;
end;
$$;

revoke all on function public.user_can_access_offline_event(uuid, text, jsonb, boolean) from public;
grant execute on function public.user_can_access_offline_event(uuid, text, jsonb, boolean) to authenticated;

drop policy if exists "offline_event_log_tenant_access" on public.offline_event_log;
drop policy if exists "offline_event_log_select" on public.offline_event_log;
drop policy if exists "offline_event_log_insert" on public.offline_event_log;
create policy "offline_event_log_select" on public.offline_event_log for select to authenticated
using (public.user_can_access_offline_event(tenant_id, event_kind, payload, true));
create policy "offline_event_log_insert" on public.offline_event_log for insert to authenticated
with check (public.user_can_access_offline_event(tenant_id, event_kind, payload, false));

-- Las imagenes del catalogo solo pueden modificarlas owner/admin.
drop policy if exists "product_images_tenant_insert" on storage.objects;
drop policy if exists "product_images_tenant_update" on storage.objects;
drop policy if exists "product_images_tenant_delete" on storage.objects;
create policy "product_images_tenant_insert" on storage.objects for insert to authenticated
with check (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
create policy "product_images_tenant_update" on storage.objects for update to authenticated
using (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
create policy "product_images_tenant_delete" on storage.objects for delete to authenticated
using (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);

commit;
