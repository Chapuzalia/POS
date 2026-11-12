-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New evidence table and RPC only; clients may read their tenant's receipts but cannot forge or modify them.
-- Pending contracts concern unrelated ticket/fiscal/accounting cleanup; none applies to this expansion.

create schema billing_legal;
grant usage on schema billing_legal to service_role, authenticated;

create table billing_legal.acceptances (
  operation_id uuid primary key references public.billing_operations(id),
  tenant_id uuid not null references public.tenants(id),
  actor_id uuid not null references public.profiles(id),
  accepted_at timestamptz not null default now(),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object')
);
create index billing_legal_acceptances_tenant_date on billing_legal.acceptances(tenant_id, accepted_at desc);
alter table billing_legal.acceptances enable row level security;
grant select, insert on billing_legal.acceptances to service_role;
grant select on billing_legal.acceptances to authenticated;
create policy billing_legal_acceptances_owner_read on billing_legal.acceptances for select to authenticated using (
  exists (select 1 from public.tenant_memberships m where m.tenant_id = acceptances.tenant_id
    and m.user_id = (select auth.uid()) and m.role = 'owner' and m.is_active)
);

-- Claim and receipt commit together, before any Mollie customer, mandate or payment is created.
create function public.billing_accept_contract(p_tenant_id uuid, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  actor uuid := (p_data->>'actorId')::uuid;
  op jsonb;
  evidence billing_legal.acceptances;
begin
  if current_user not in ('service_role','postgres','supabase_admin') or not exists (
    select 1 from public.tenant_memberships m where m.tenant_id = p_tenant_id and m.user_id = actor and m.role = 'owner' and m.is_active
  ) then raise exception 'BILLING_FORBIDDEN' using errcode = '42501'; end if;
  op := public.billing_transition('apply_claim', jsonb_build_object('tenantId',p_tenant_id,'actorId',actor,'operationId',p_data->>'operationId'));
  if op->>'status' <> 'applying' or op->>'kind' <> 'change' or op->'stripe_params'->>'subscriptionId' is not null
    or p_data->'receipt'->'contract' is distinct from op->'contract'
    or p_data->'receipt'->'offer'->'amountDueCents' is distinct from op->'preview'->'amountDueCents'
    or p_data->'receipt'->'declarations' is distinct from '{"terms":true,"dpa":true,"businessRepresentative":true}'::jsonb
  then raise exception 'BILLING_LEGAL_REQUIRED'; end if;
  insert into billing_legal.acceptances(operation_id,tenant_id,actor_id,receipt)
  values ((op->>'id')::uuid,p_tenant_id,actor,p_data->'receipt') on conflict (operation_id) do nothing;
  select * into evidence from billing_legal.acceptances where operation_id = (op->>'id')::uuid;
  if evidence.tenant_id is distinct from p_tenant_id or evidence.actor_id is distinct from actor or evidence.receipt is distinct from p_data->'receipt'
    then raise exception 'BILLING_LEGAL_REQUIRED'; end if;
  return op;
end;
$$;
revoke all on function public.billing_accept_contract(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.billing_accept_contract(uuid,jsonb) to service_role;

-- No Data API exposure of the private schema. The authenticated endpoint scopes this read.
create function public.billing_legal_receipts(p_tenant_id uuid, p_data jsonb)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.accepted_at desc), '[]'::jsonb)
  from (
    select * from billing_legal.acceptances
    where tenant_id = p_tenant_id and (not (p_data ? 'operationId') or operation_id = (p_data->>'operationId')::uuid)
    order by accepted_at desc limit 50
  ) e;
$$;
revoke all on function public.billing_legal_receipts(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.billing_legal_receipts(uuid,jsonb) to service_role;
