-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.fiscal_entity_venues
  add column if not exists fiscal_series_code text
    check (fiscal_series_code is null or fiscal_series_code ~ '^[A-Z0-9]{1,3}$');

create unique index if not exists fiscal_entity_venues_series_code_unique_idx
  on public.fiscal_entity_venues (fiscal_entity_id, fiscal_series_code)
  where fiscal_series_code is not null;
