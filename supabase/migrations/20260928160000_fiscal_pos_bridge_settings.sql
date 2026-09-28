-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Public producer metadata and the transport origin only. Credentials stay outside the PWA.
create table public.fiscal_pos_bridge_settings (
  tenant_id uuid primary key references public.tenants(id) on delete restrict,
  bridge_url text not null check (bridge_url ~ '^https://[^/?#@]+/?$' and length(bridge_url) <= 255),
  producer_name text not null check (length(trim(producer_name)) between 1 and 120),
  producer_nif text not null check (producer_nif ~ '^[A-Z0-9]{9}$'),
  system_id text not null check (system_id ~ '^[A-Z0-9]{2}$'),
  system_version text not null check (length(trim(system_version)) between 1 and 40),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create function public.fiscal_pos_bridge_settings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'Fiscal bridge settings cannot move between tenants' using errcode = '23514';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger fiscal_pos_bridge_settings_audit before update on public.fiscal_pos_bridge_settings
for each row execute function public.fiscal_pos_bridge_settings_guard();

alter table public.fiscal_pos_bridge_settings enable row level security;
create policy fiscal_pos_bridge_settings_read on public.fiscal_pos_bridge_settings for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or exists (
  select 1 from public.fiscal_sif_installations i
  where i.tenant_id = fiscal_pos_bridge_settings.tenant_id
    and i.retired_at is null and public.user_has_venue_access(i.tenant_id, i.venue_id)
));
create policy fiscal_pos_bridge_settings_owner_insert on public.fiscal_pos_bridge_settings for insert to authenticated
with check (exists (select 1 from public.tenant_memberships m where m.tenant_id = fiscal_pos_bridge_settings.tenant_id
  and m.user_id = auth.uid() and m.role = 'owner' and m.is_active = true));
create policy fiscal_pos_bridge_settings_owner_update on public.fiscal_pos_bridge_settings for update to authenticated
using (exists (select 1 from public.tenant_memberships m where m.tenant_id = fiscal_pos_bridge_settings.tenant_id
  and m.user_id = auth.uid() and m.role = 'owner' and m.is_active = true))
with check (exists (select 1 from public.tenant_memberships m where m.tenant_id = fiscal_pos_bridge_settings.tenant_id
  and m.user_id = auth.uid() and m.role = 'owner' and m.is_active = true));

grant select, insert, update on public.fiscal_pos_bridge_settings to authenticated;
