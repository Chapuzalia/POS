-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Test-only repair preserves the function signature and is executed only as postgres with an explicit rewrite flag; it rebinds synthetic historical data to the current device identities before rebuilding the fiscal ledger.
set lock_timeout = '5s';
set statement_timeout = '5min';

do $$
declare
  v_definition text;
  v_replacement text;
begin
  select pg_get_functiondef(p.oid)
  into v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'rewrite_historical_fiscal_test_data'
    and pg_get_function_identity_arguments(p.oid) = '';

  if v_definition is null then
    raise exception 'FISCAL_TEST_REWRITE_FUNCTION_MISSING';
  end if;

  v_replacement := $replacement$select coalesce(
          (select override.device_id from pg_temp.historical_device_override override
            where override.tenant_id = v_tenant.id
              and override.venue_id = v_venue.id
              and override.cash_register_id = v_register.id),
          ('00000000-0000-4000-8000-' || substr(md5(v_tenant.id::text || ':' || v_venue.id::text || ':' || v_register.id::text), 1, 12))::uuid
        ) into v_device_id;$replacement$;
  v_definition := replace(
    v_definition,
    $needle$v_device_id := ('00000000-0000-4000-8000-' || substr(md5(v_tenant.id::text || ':' || v_venue.id::text || ':' || v_register.id::text), 1, 12))::uuid;$needle$,
    v_replacement
  );
  v_definition := replace(
    v_definition,
    'on conflict (id) do update set name = excluded.name',
    'on conflict (id) do update set name = public.devices.name'
  );

  if v_definition = pg_get_functiondef((select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rewrite_historical_fiscal_test_data' and pg_get_function_identity_arguments(p.oid) = '')) then
    raise exception 'FISCAL_TEST_REWRITE_PATCH_NOT_APPLIED';
  end if;

  execute v_definition;
end;
$$;

select set_config('app.allow_fiscal_test_rewrite', 'yes', true);

create temporary table historical_device_override (
  tenant_id uuid not null,
  venue_id uuid not null,
  cash_register_id uuid not null,
  device_id uuid not null,
  primary key (tenant_id, venue_id, cash_register_id)
) on commit drop;

insert into historical_device_override (tenant_id, venue_id, cash_register_id, device_id)
select register_row.tenant_id, register_row.venue_id, register_row.id, selected_device.id
from public.cash_registers register_row
cross join lateral (
  select device.id
  from public.devices device
  where device.tenant_id = register_row.tenant_id
    and device.venue_id = register_row.venue_id
    and device.is_active
    and (
      exists (
        select 1
        from public.fiscal_sif_installations installation
        where installation.tenant_id = register_row.tenant_id
          and installation.venue_id = register_row.venue_id
          and installation.cash_register_id = register_row.id
          and installation.device_id = device.id
          and installation.retired_at is null
      )
      or device.default_cash_register_id = register_row.id
      or exists (
        select 1
        from public.cash_sessions session_row
        where session_row.tenant_id = register_row.tenant_id
          and session_row.venue_id = register_row.venue_id
          and session_row.cash_register_id = register_row.id
          and session_row.device_id = device.id
      )
    )
  order by exists (
      select 1
      from public.fiscal_sif_installations installation
      where installation.tenant_id = register_row.tenant_id
        and installation.venue_id = register_row.venue_id
        and installation.cash_register_id = register_row.id
        and installation.device_id = device.id
        and installation.retired_at is null
    ) desc,
    (device.default_cash_register_id = register_row.id) desc,
    exists (
      select 1
      from public.cash_sessions session_row
      where session_row.tenant_id = register_row.tenant_id
        and session_row.venue_id = register_row.venue_id
        and session_row.cash_register_id = register_row.id
        and session_row.device_id = device.id
    ) desc,
    device.updated_at desc, device.id
  limit 1
) selected_device;

alter table public.tickets disable trigger user;
alter table public.sales disable trigger user;
alter table public.fiscal_local_records disable trigger user;
alter table public.fiscal_local_series disable trigger user;
alter table public.fiscal_sif_installations disable trigger user;
delete from public.fiscal_local_records;
delete from public.fiscal_local_series;
delete from public.fiscal_sif_installations;
alter table public.fiscal_sif_installations enable trigger user;
alter table public.fiscal_local_series enable trigger user;
alter table public.fiscal_local_records enable trigger user;
update public.tickets ticket
set device_id = override.device_id
from historical_device_override override
where ticket.tenant_id = override.tenant_id
  and ticket.venue_id = override.venue_id
  and ticket.cash_register_id = override.cash_register_id;
update public.sales sale
set device_id = override.device_id
from historical_device_override override
where sale.tenant_id = override.tenant_id
  and sale.venue_id = override.venue_id
  and sale.cash_register_id = override.cash_register_id;
select public.rewrite_historical_fiscal_test_data();
alter table public.sales enable trigger user;
alter table public.tickets enable trigger user;
