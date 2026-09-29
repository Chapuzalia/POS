-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.fiscal_pos_bridge_settings
  add column aeat_environment text not null default 'production'
  check (aeat_environment in ('test', 'production'));
