-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Restrict only the new profile RPC to the service role; preserve all existing client grants.

alter table public.billing_accounts add column billing_address jsonb
  check (billing_address is null or jsonb_typeof(billing_address) = 'object');

-- The billing endpoint checks active owner/superadmin access; no direct client writes.
create function public.billing_save_profile(p_tenant_id uuid, p_data jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update public.billing_accounts
  set legal_name = p_data->>'legalName', tax_id = p_data->>'taxId',
      email = case when p_data ? 'email' then p_data->>'email' else email end,
      billing_address = case when p_data ? 'address' then p_data->'address'
        when legal_name is not distinct from p_data->>'legalName' and tax_id is not distinct from p_data->>'taxId' then billing_address
        else null end,
      updated_at = now()
  where tenant_id = p_tenant_id;
  if not found then raise exception 'BILLING_ACCOUNT_REQUIRED'; end if;
  insert into public.billing_audit(tenant_id, actor_id, action, reason)
  values (p_tenant_id, (p_data->>'actorId')::uuid, 'profile', 'Datos de facturación');
end;
$$;
revoke all on function public.billing_save_profile(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.billing_save_profile(uuid, jsonb) to service_role;
