-- migration-safety: expand
-- migration-safety-reviewed: REVOKE, CREATE OR REPLACE ROUTINE
-- migration-safety-reason: New scoped RPCs and compatible sale guard retain the trigger signature, fiscal sync bypass and historical/offline records; tenant activation replaces the global installation gate.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- The legacy verifacti cleanup is deferred: N-1 clients and historical data still
-- reference it. This expand does not consume legacy-verifacti-ticketbai-removal.
create table public.tenant_verifactu_integrations (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  requested_at timestamptz,
  requested_by uuid references auth.users(id) on delete set null,
  enabled_at timestamptz,
  enabled_by uuid references auth.users(id) on delete set null,
  aeat_environment text not null default 'production' check (aeat_environment in ('test', 'production')),
  print_ticket_qr boolean not null default true,
  check (enabled_at is null or requested_at is not null)
);
create index tenant_verifactu_requested_by_idx on public.tenant_verifactu_integrations(requested_by);
create index tenant_verifactu_enabled_by_idx on public.tenant_verifactu_integrations(enabled_by);
alter table public.tenant_verifactu_integrations enable row level security;
create policy tenant_verifactu_read on public.tenant_verifactu_integrations for select to authenticated
using (public.user_is_superadmin() or exists (
  select 1 from public.tenant_memberships m where m.tenant_id = tenant_verifactu_integrations.tenant_id
    and m.user_id = (select auth.uid()) and m.is_active = true
));
grant select on public.tenant_verifactu_integrations to authenticated;
grant all on public.tenant_verifactu_integrations to service_role;

-- Preserve already configured remissions; local-only configurations move to legacy.
insert into public.tenant_verifactu_integrations(tenant_id, requested_at, enabled_at, aeat_environment, print_ticket_qr)
select tenant_id, case when bridge_url is not null then now() end,
  case when bridge_url is not null then now() end, aeat_environment, print_ticket_qr
from public.fiscal_pos_bridge_settings;

-- Keep existing owner policies for N-1 clients; the new restriction protects
-- producer and transport configuration. Owner preferences use the narrow RPC.
create policy fiscal_settings_platform_read on public.fiscal_pos_bridge_settings for select to authenticated
using (public.user_is_superadmin());
create policy fiscal_settings_platform_insert on public.fiscal_pos_bridge_settings for insert to authenticated
with check (public.user_is_superadmin());
create policy fiscal_settings_platform_update on public.fiscal_pos_bridge_settings for update to authenticated
using (public.user_is_superadmin()) with check (public.user_is_superadmin());
create policy fiscal_settings_managed_insert on public.fiscal_pos_bridge_settings as restrictive for insert to authenticated
with check (public.user_is_superadmin());
create policy fiscal_settings_managed_update on public.fiscal_pos_bridge_settings as restrictive for update to authenticated
using (public.user_is_superadmin()) with check (public.user_is_superadmin());

create function public.request_verifactu_activation(p_tenant_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result public.tenant_verifactu_integrations;
begin
  if auth.uid() is null or not exists (select 1 from public.tenant_memberships m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid() and m.role = 'owner' and m.is_active) then
    raise exception 'Solo el propietario puede solicitar Verifactu' using errcode = '42501';
  end if;
  insert into public.tenant_verifactu_integrations(tenant_id, requested_at, requested_by)
  values (p_tenant_id, now(), auth.uid()) on conflict (tenant_id) do update
  set requested_at = coalesce(tenant_verifactu_integrations.requested_at, excluded.requested_at),
      requested_by = coalesce(tenant_verifactu_integrations.requested_by, excluded.requested_by)
  returning * into result;
  return to_jsonb(result);
end;
$$;

create function public.save_verifactu_preferences(p_tenant_id uuid, p_aeat_environment text, p_print_ticket_qr boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result public.tenant_verifactu_integrations;
begin
  if auth.uid() is null or not exists (select 1 from public.tenant_memberships m
    where m.tenant_id = p_tenant_id and m.user_id = auth.uid() and m.role = 'owner' and m.is_active) then
    raise exception 'Solo el propietario puede cambiar las preferencias Verifactu' using errcode = '42501';
  end if;
  insert into public.tenant_verifactu_integrations(tenant_id, aeat_environment, print_ticket_qr)
  values (p_tenant_id, p_aeat_environment, p_print_ticket_qr) on conflict (tenant_id) do update
  set aeat_environment = excluded.aeat_environment, print_ticket_qr = excluded.print_ticket_qr
  returning * into result;
  update public.fiscal_pos_bridge_settings set aeat_environment = p_aeat_environment, print_ticket_qr = p_print_ticket_qr
  where tenant_id = p_tenant_id;
  return to_jsonb(result);
end;
$$;

create function public.configure_verifactu_integration(p_tenant_id uuid, p_bridge_url text, p_producer_name text,
  p_producer_nif text, p_system_id text, p_system_version text, p_activate boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result public.tenant_verifactu_integrations;
begin
  if auth.uid() is null or not public.user_is_superadmin() then
    raise exception 'Solo el superadmin puede configurar y activar Verifactu' using errcode = '42501';
  end if;
  select * into result from public.tenant_verifactu_integrations where tenant_id = p_tenant_id for update;
  if not found or result.requested_at is null then
    raise exception 'El cliente no ha solicitado Verifactu' using errcode = '23514';
  end if;
  if (p_activate or result.enabled_at is not null) and nullif(trim(p_bridge_url), '') is null then
    raise exception 'Configura la URL del puente antes de activar Verifactu' using errcode = '23514';
  end if;
  insert into public.fiscal_pos_bridge_settings(tenant_id, bridge_url, producer_name, producer_nif, system_id, system_version, aeat_environment, print_ticket_qr)
  values (p_tenant_id, nullif(trim(p_bridge_url), ''), trim(p_producer_name), upper(trim(p_producer_nif)), upper(trim(p_system_id)), trim(p_system_version), result.aeat_environment, result.print_ticket_qr)
  on conflict (tenant_id) do update set bridge_url = excluded.bridge_url, producer_name = excluded.producer_name,
    producer_nif = excluded.producer_nif, system_id = excluded.system_id, system_version = excluded.system_version;
  if p_activate then
    update public.tenant_verifactu_integrations set enabled_at = coalesce(enabled_at, now()), enabled_by = coalesce(enabled_by, auth.uid())
    where tenant_id = p_tenant_id returning * into result;
  end if;
  return to_jsonb(result);
end;
$$;

revoke all on function public.request_verifactu_activation(uuid) from public, anon;
revoke all on function public.save_verifactu_preferences(uuid, text, boolean) from public, anon;
revoke all on function public.configure_verifactu_integration(uuid, text, text, text, text, text, boolean) from public, anon;
grant execute on function public.request_verifactu_activation(uuid) to authenticated;
grant execute on function public.save_verifactu_preferences(uuid, text, boolean) to authenticated;
grant execute on function public.configure_verifactu_integration(uuid, text, text, text, text, text, boolean) to authenticated;

-- An offline legacy sale generated before activation retains its original path.
-- Fiscal RPCs already set this transaction-local flag after validating the record.
create or replace function public.fiscal_local_require_sale_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from public.tenant_verifactu_integrations integration
    where integration.tenant_id = new.tenant_id and integration.enabled_at is not null
      and new.local_created_at >= integration.enabled_at
  ) and coalesce(current_setting('app.local_fiscal_sale', true), '') <> 'yes' then
    raise exception 'LOCAL_FISCAL_RECORD_REQUIRED' using errcode = '55000';
  end if;
  return new;
end;
$$;
