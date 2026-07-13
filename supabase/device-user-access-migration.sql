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

alter table public.products
add column if not exists catalog_by_venue boolean not null default false;

alter table public.products
add column if not exists venue_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_venue_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
    add constraint products_venue_id_fkey
    foreign key (venue_id) references public.venues(id) on delete restrict;
  end if;
end $$;

create table if not exists public.product_venue_settings (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, venue_id)
);

create index if not exists product_venue_settings_tenant_venue_idx
on public.product_venue_settings (tenant_id, venue_id, product_id);

-- Convierte el catalogo compartido anterior en productos independientes por local.
do $$
declare
  source_product public.products%rowtype;
  target_venue_ids uuid[];
  target_venue_id uuid;
  cloned_product_id uuid;
  source_group record;
  cloned_group_id uuid;
begin
  for source_product in
    select * from public.products where venue_id is null
  loop
    if source_product.catalog_by_venue then
      select array_agg(pvs.venue_id order by v.sort_order, v.name)
      into target_venue_ids
      from public.product_venue_settings pvs
      join public.venues v on v.id = pvs.venue_id
      where pvs.product_id = source_product.id
        and pvs.tenant_id = source_product.tenant_id
        and pvs.is_available = true;
    else
      select array_agg(v.id order by v.sort_order, v.name)
      into target_venue_ids
      from public.venues v
      where v.tenant_id = source_product.tenant_id
        and v.is_active = true;
    end if;

    if coalesce(array_length(target_venue_ids, 1), 0) = 0 then
      select array[v.id]
      into target_venue_ids
      from public.venues v
      where v.tenant_id = source_product.tenant_id
      order by v.sort_order, v.name
      limit 1;

      update public.products
      set is_active = false
      where id = source_product.id;
    end if;

    if coalesce(array_length(target_venue_ids, 1), 0) = 0 then
      raise exception 'El negocio % necesita al menos un local antes de separar su catalogo', source_product.tenant_id;
    end if;

    update public.products
    set venue_id = target_venue_ids[1], catalog_by_venue = false
    where id = source_product.id;

    foreach target_venue_id in array coalesce(target_venue_ids[2:], array[]::uuid[])
    loop
      insert into public.products (
        tenant_id, venue_id, category_id, name, description, image_path, kind,
        sale_formats, can_sell_standalone, can_use_as_mixer, is_featured,
        mixer_supplement_cents, is_active, sort_order, catalog_by_venue
      ) values (
        source_product.tenant_id, target_venue_id, source_product.category_id,
        source_product.name, source_product.description, source_product.image_path,
        source_product.kind, source_product.sale_formats, source_product.can_sell_standalone,
        source_product.can_use_as_mixer, source_product.is_featured,
        source_product.mixer_supplement_cents, source_product.is_active,
        source_product.sort_order, false
      ) returning id into cloned_product_id;

      insert into public.product_variants (
        tenant_id, product_id, name, price_cents, sku, is_default, sort_order
      )
      select tenant_id, cloned_product_id, name, price_cents, sku, is_default, sort_order
      from public.product_variants
      where product_id = source_product.id;

      for source_group in
        select * from public.modifier_groups where product_id = source_product.id
      loop
        insert into public.modifier_groups (
          tenant_id, product_id, name, min_select, max_select, sort_order
        ) values (
          source_group.tenant_id, cloned_product_id, source_group.name,
          source_group.min_select, source_group.max_select, source_group.sort_order
        ) returning id into cloned_group_id;

        insert into public.modifiers (tenant_id, group_id, name, price_cents, sort_order)
        select tenant_id, cloned_group_id, name, price_cents, sort_order
        from public.modifiers
        where group_id = source_group.id;
      end loop;
    end loop;
  end loop;
end $$;

alter table public.products
alter column venue_id set not null;

create or replace function public.validate_product_venue()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.venues v
    where v.id = new.venue_id and v.tenant_id = new.tenant_id
  ) then
    raise exception 'El producto debe pertenecer a un local del mismo negocio';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_product_venue on public.products;
create trigger validate_product_venue
before insert or update of tenant_id, venue_id on public.products
for each row execute function public.validate_product_venue();

revoke all on function public.validate_product_venue() from public;

create or replace function public.validate_ticket_line_product_venue()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.product_id is not null and not exists (
    select 1
    from public.tickets t
    join public.products p
      on p.id = new.product_id
     and p.tenant_id = t.tenant_id
     and p.venue_id = t.venue_id
    where t.id = new.ticket_id
      and t.tenant_id = new.tenant_id
  ) then
    raise exception 'El producto de la linea no pertenece al local del ticket';
  end if;

  if new.variant_id is not null and not exists (
    select 1
    from public.product_variants pv
    where pv.id = new.variant_id
      and pv.product_id = new.product_id
      and pv.tenant_id = new.tenant_id
  ) then
    raise exception 'La variante no pertenece al producto de la linea';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_ticket_line_product_venue on public.ticket_lines;
create trigger validate_ticket_line_product_venue
before insert or update of tenant_id, ticket_id, product_id, variant_id on public.ticket_lines
for each row execute function public.validate_ticket_line_product_venue();

revoke all on function public.validate_ticket_line_product_venue() from public;

create index if not exists products_tenant_venue_idx
on public.products (tenant_id, venue_id, sort_order);

create table if not exists public.user_login_leases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  auth_session_id text not null,
  client_id uuid not null,
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 seconds')
);

create index if not exists user_login_leases_expiry_idx
on public.user_login_leases (expires_at);

alter table public.device_user_assignments enable row level security;
alter table public.product_venue_settings enable row level security;
alter table public.user_login_leases enable row level security;

create or replace function public.validate_product_venue_setting()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.products p
    where p.id = new.product_id and p.tenant_id = new.tenant_id
  ) or not exists (
    select 1 from public.venues v
    where v.id = new.venue_id and v.tenant_id = new.tenant_id
  ) then
    raise exception 'El producto y el local deben pertenecer al mismo negocio';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_product_venue_setting on public.product_venue_settings;
create trigger validate_product_venue_setting
before insert or update on public.product_venue_settings
for each row execute function public.validate_product_venue_setting();

revoke all on function public.validate_product_venue_setting() from public;

create or replace function public.claim_user_login(p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
  claimed boolean := false;
begin
  if current_user_id is null or current_session_id is null or p_client_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, now(), now() + interval '90 seconds'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
  where (
    public.user_login_leases.auth_session_id = excluded.auth_session_id
    and public.user_login_leases.client_id = excluded.client_id
  ) or public.user_login_leases.expires_at <= now()
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.heartbeat_user_login(p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
  refreshed boolean := false;
begin
  update public.user_login_leases
  set heartbeat_at = now(),
      expires_at = now() + interval '90 seconds'
  where user_id = current_user_id
    and auth_session_id = current_session_id
    and client_id = p_client_id
  returning true into refreshed;

  return coalesce(refreshed, false);
end;
$$;

create or replace function public.release_user_login(p_client_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.user_login_leases
  where user_id = auth.uid()
    and auth_session_id = (auth.jwt() ->> 'session_id')
    and client_id = p_client_id;
$$;

revoke all on function public.claim_user_login(uuid) from public;
revoke all on function public.heartbeat_user_login(uuid) from public;
revoke all on function public.release_user_login(uuid) from public;
grant execute on function public.claim_user_login(uuid) to authenticated;
grant execute on function public.heartbeat_user_login(uuid) to authenticated;
grant execute on function public.release_user_login(uuid) to authenticated;

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

create or replace function public.user_has_venue_access(target_tenant uuid, target_venue uuid)
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
      on tm.tenant_id = dua.tenant_id and tm.user_id = dua.user_id
    where dua.tenant_id = target_tenant
      and dua.venue_id = target_venue
      and dua.user_id = auth.uid()
      and dua.is_active = true
      and tm.is_active = true
      and tm.role = 'cashier'
  );
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
revoke all on function public.user_has_venue_access(uuid, uuid) from public;
revoke all on function public.validate_device_user_assignment() from public;
grant execute on function public.user_is_tenant_admin(uuid) to authenticated;
grant execute on function public.user_has_device_access(uuid, uuid, uuid) to authenticated;
grant execute on function public.user_can_view_device(uuid, uuid, uuid) to authenticated;
grant execute on function public.user_has_venue_access(uuid, uuid) to authenticated;

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

drop policy if exists "product_venue_settings_select" on public.product_venue_settings;
drop policy if exists "product_venue_settings_admin_manage" on public.product_venue_settings;
create policy "product_venue_settings_select" on public.product_venue_settings
for select to authenticated
using (public.user_has_tenant_access(tenant_id));
create policy "product_venue_settings_admin_manage" on public.product_venue_settings
for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop trigger if exists set_product_venue_settings_updated_at on public.product_venue_settings;
create trigger set_product_venue_settings_updated_at
before update on public.product_venue_settings
for each row execute function public.set_updated_at();

-- Catalogo legible para todos los miembros, modificable solo por administracion.
do $$
declare
  table_name text;
  old_policy text;
begin
  foreach table_name in array array[
    'categories', 'sale_formats'
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

drop policy if exists "products_tenant_access" on public.products;
drop policy if exists "products_select" on public.products;
drop policy if exists "products_admin_manage" on public.products;
create policy "products_select" on public.products for select to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);
create policy "products_admin_manage" on public.products for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "product_variants_tenant_access" on public.product_variants;
drop policy if exists "product_variants_select" on public.product_variants;
drop policy if exists "product_variants_admin_manage" on public.product_variants;
create policy "product_variants_select" on public.product_variants for select to authenticated
using (exists (
  select 1 from public.products p
  where p.id = product_variants.product_id
    and (public.user_is_tenant_admin(p.tenant_id) or public.user_has_venue_access(p.tenant_id, p.venue_id))
));
create policy "product_variants_admin_manage" on public.product_variants for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "modifier_groups_tenant_access" on public.modifier_groups;
drop policy if exists "modifier_groups_select" on public.modifier_groups;
drop policy if exists "modifier_groups_admin_manage" on public.modifier_groups;
create policy "modifier_groups_select" on public.modifier_groups for select to authenticated
using (exists (
  select 1 from public.products p
  where p.id = modifier_groups.product_id
    and (public.user_is_tenant_admin(p.tenant_id) or public.user_has_venue_access(p.tenant_id, p.venue_id))
));
create policy "modifier_groups_admin_manage" on public.modifier_groups for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

drop policy if exists "modifiers_tenant_access" on public.modifiers;
drop policy if exists "modifiers_select" on public.modifiers;
drop policy if exists "modifiers_admin_manage" on public.modifiers;
create policy "modifiers_select" on public.modifiers for select to authenticated
using (exists (
  select 1
  from public.modifier_groups mg
  join public.products p on p.id = mg.product_id
  where mg.id = modifiers.group_id
    and (public.user_is_tenant_admin(p.tenant_id) or public.user_has_venue_access(p.tenant_id, p.venue_id))
));
create policy "modifiers_admin_manage" on public.modifiers for all to authenticated
using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

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
drop policy if exists "product_images_tenant_select" on storage.objects;
drop policy if exists "product_images_tenant_insert" on storage.objects;
drop policy if exists "product_images_tenant_update" on storage.objects;
drop policy if exists "product_images_tenant_delete" on storage.objects;
create policy "product_images_tenant_select" on storage.objects for select to authenticated
using (
  bucket_id = 'product-images'
  and public.user_is_tenant_admin(((storage.foldername(name))[1])::uuid)
);
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

-- La disponibilidad compartida queda sustituida por products.venue_id.
drop table if exists public.product_venue_settings;
alter table public.products drop column if exists catalog_by_venue;
drop function if exists public.validate_product_venue_setting();

commit;
