-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Test-only repair preserves routine signatures and corrects predecessor selection to use the immediately preceding chain position.
set lock_timeout = '5s';
set statement_timeout = '5min';

do $$
declare
  v_definition text;
  v_original text;
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

  v_original := $original$select coalesce(max(chain_position), 0) + 1, max(hash)
    into v_position, v_previous_hash
    from public.fiscal_local_records
    where tenant_id = v_ticket.tenant_id and installation_id = v_installation.id;$original$;
  v_replacement := $replacement$select coalesce(max(chain_position), 0) + 1
    into v_position
    from public.fiscal_local_records
    where tenant_id = v_ticket.tenant_id and installation_id = v_installation.id;
    select record.hash
    into v_previous_hash
    from public.fiscal_local_records record
    where record.tenant_id = v_ticket.tenant_id
      and record.installation_id = v_installation.id
    order by record.chain_position desc
    limit 1;$replacement$;
  v_definition := replace(v_definition, v_original, v_replacement);

  if position(v_replacement in v_definition) = 0 then
    raise exception 'FISCAL_TEST_CHAIN_PATCH_NOT_APPLIED';
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
    device.updated_at desc,
    device.id
  limit 1
) selected_device;

alter table public.tickets disable trigger user;
alter table public.sales disable trigger user;
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
select public.repair_historical_fiscal_local_snapshots();
alter table public.sales enable trigger user;
alter table public.tickets enable trigger user;
