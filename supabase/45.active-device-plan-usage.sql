-- Los dispositivos retirados conservan su histórico, pero no consumen una plaza
-- del plan. Los nombres solo deben ser únicos entre dispositivos activos.

begin;

alter table public.devices
  drop constraint if exists devices_tenant_id_venue_id_name_key;

create unique index if not exists devices_active_venue_name_key
  on public.devices (tenant_id, venue_id, lower(name))
  where is_active;

create or replace function public.enforce_tenant_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_usage integer;
  resource_limit integer;
  resource_label text;
begin
  if tg_table_name = 'venues' then
    select max_venues into resource_limit from public.tenants where id = new.tenant_id for update;
    select count(*) into current_usage from public.venues where tenant_id = new.tenant_id;
    resource_label := 'locales';
  elsif tg_table_name = 'devices' then
    select max_devices into resource_limit from public.tenants where id = new.tenant_id for update;
    select count(*) into current_usage from public.devices where tenant_id = new.tenant_id and is_active;
    resource_label := 'dispositivos';
  elsif tg_table_name = 'tenant_memberships' then
    if new.role <> 'cashier' then return new; end if;
    select max_devices into resource_limit from public.tenants where id = new.tenant_id for update;
    select count(*) into current_usage from public.tenant_memberships where tenant_id = new.tenant_id and role = 'cashier';
    resource_label := 'usuarios';
  else
    return new;
  end if;

  if resource_limit is null then raise exception 'El negocio no existe.' using errcode = 'P0001'; end if;
  if current_usage >= resource_limit then
    raise exception 'Has alcanzado el límite de % de tu plan (%).', resource_label, resource_limit using errcode = 'P0001';
  end if;
  return new;
end;
$$;

commit;
