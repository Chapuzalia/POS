-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve signature, grants and invoker/RLS checks; project confirmed restaurant economic IDs without changing stored fiscal documents or non-restaurant responses.
-- Preserve the RPC signature, privileges and invoker/RLS boundary. Restaurant
-- RPCs persist the original draft snapshot and return definitive economic IDs.
-- Project those confirmed IDs for transport without rewriting issued history.
create or replace function public.fiscal_bridge_confirm_record(p_installation_id uuid,p_record_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'record', r.record_envelope,
    'snapshot', case
      when r.record_kind = 'alta' and r.rpc_result is not null
        and r.ticket_id is not null and r.sale_id is not null
        and r.rpc_result ? 'ticketId' and r.rpc_result ? 'saleId'
      then r.invoice_snapshot || jsonb_build_object(
        'ticketId', r.ticket_id,
        'saleId', r.sale_id,
        'paymentId', coalesce(r.rpc_result ->> 'paymentId',
          case when r.invoice_snapshot ->> 'paymentId' is not null then r.sale_id::text end)
      )
      else r.invoice_snapshot
    end,
    'reason', r.economic_snapshot ->> 'reason'
  )
  from public.fiscal_local_records r
  join public.fiscal_sif_installations i on i.id = r.installation_id and i.tenant_id = r.tenant_id
  where i.retired_for_verifactu_at is null
    and exists(select 1 from public.tenant_verifactu_integrations integration
      where integration.tenant_id = i.tenant_id and integration.enabled_at is not null)
    and auth.uid() is not null and i.id = p_installation_id and i.bridge_requested and r.id = p_record_id
    and public.user_has_device_access(i.tenant_id,i.venue_id,i.device_id);
$$;
