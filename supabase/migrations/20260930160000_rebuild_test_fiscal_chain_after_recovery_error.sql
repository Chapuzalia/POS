-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

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
      device.default_cash_register_id = register_row.id
      or exists (
        select 1
        from public.cash_sessions session_row
        where session_row.tenant_id = register_row.tenant_id
          and session_row.venue_id = register_row.venue_id
          and session_row.cash_register_id = register_row.id
          and session_row.device_id = device.id
      )
    )
  order by (device.default_cash_register_id = register_row.id) desc,
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
