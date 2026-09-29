-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- A tenant may prepare and retain fiscal records locally before enabling the VPS transport.
-- The existing CHECK already accepts NULL and continues rejecting malformed non-null origins.
alter table public.fiscal_pos_bridge_settings
  alter column bridge_url drop not null;
