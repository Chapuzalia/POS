-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserves the annulment RPC signature, permissions and behavior while parenthesizing its JSON text extraction before series-number concatenation.
set lock_timeout = '5s';
set statement_timeout = '5min';

do $$
declare
  d text;
begin
  select pg_get_functiondef(p.oid) into d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'sync_local_fiscal_ticket_annulment'
      and pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid, p_record jsonb, p_invoice jsonb, p_reason text';
  if d is not null then
    d := replace(d,
      'p_invoice ->> ''series'' || ''/'' || p_invoice ->> ''number''',
      '(p_invoice ->> ''series'') || ''/'' || (p_invoice ->> ''number'')');
    d := replace(d,
      'create function public.sync_local_fiscal_ticket_annulment(',
      'create or replace function public.sync_local_fiscal_ticket_annulment(');
    execute d;
  end if;
end $$;
