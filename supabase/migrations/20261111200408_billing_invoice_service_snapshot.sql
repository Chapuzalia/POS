-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- NULL identifies pre-existing invoices; they retain their original descriptions and reports.
alter table public.billing_invoices add column service_snapshot jsonb
  check (service_snapshot is null or jsonb_typeof(service_snapshot) = 'object');
