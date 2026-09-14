set lock_timeout = '5s';
set statement_timeout = '1min';

drop function if exists public.get_accounting_ticket_export(uuid, uuid, timestamptz, timestamptz);
