-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New authenticated-only read RPC; existing table reads and RLS remain unchanged.

-- Loft's bitmap plan checks every historical row under RLS before sorting.
-- Keep this read on the ordered index without changing the database-wide planner.
create function public.pos_fiscal_chain_head(
  p_tenant_id uuid,
  p_fiscal_subject_id uuid,
  p_installation_id uuid
)
returns table (
  id uuid,
  tenant_id uuid,
  fiscal_subject_id uuid,
  installation_id uuid,
  ticket_id uuid,
  sale_id uuid,
  refund_request_id uuid,
  record_kind text,
  chain_position bigint,
  hash text,
  record_envelope jsonb,
  invoice_snapshot jsonb,
  economic_snapshot jsonb,
  rpc_result jsonb
)
language sql
stable
security invoker
set search_path = ''
set enable_bitmapscan = off
rows 1
as $$
  select
    r.id, r.tenant_id, r.fiscal_subject_id, r.installation_id,
    r.ticket_id, r.sale_id, r.refund_request_id, r.record_kind,
    r.chain_position, r.hash, r.record_envelope, r.invoice_snapshot,
    r.economic_snapshot, r.rpc_result
  from public.fiscal_local_records r
  where auth.uid() is not null
    and r.tenant_id = p_tenant_id
    and r.fiscal_subject_id = p_fiscal_subject_id
    and r.installation_id = p_installation_id
  order by r.chain_position desc
  limit 1;
$$;

revoke all on function public.pos_fiscal_chain_head(uuid, uuid, uuid)
  from public, anon;

grant execute on function public.pos_fiscal_chain_head(uuid, uuid, uuid)
  to authenticated;
