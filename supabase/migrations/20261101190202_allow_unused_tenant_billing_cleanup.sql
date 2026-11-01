-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New invoker trigger helper is internal; revoke direct execution from public, anon and authenticated without changing existing APIs or RLS.

-- Keep the existing DELETE API compatible, including N-1 Edge Functions.
-- Cleanup runs in the parent DELETE transaction: a later FK/fiscal failure
-- restores the account as well as every cascaded row. No data is changed on install.
create function public.cleanup_unused_tenant_billing() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  account public.billing_accounts;
begin
  select * into account from public.billing_accounts where tenant_id = old.id for update;
  if not found then return old; end if;

  -- Never orphan a Stripe customer/subscription, an in-flight reconciliation,
  -- commercial history or invoice snapshots. These tenants can be deactivated.
  if account.stripe_customer_id is not null or account.stripe_subscription_id is not null
    or account.contract is not null or account.billed_contract is not null
    or account.sync_token is not null or account.sync_until is not null
    or account.status not in ('manual', 'pending_payment')
    or exists(select 1 from public.billing_operations where tenant_id = old.id)
    or exists(select 1 from public.billing_invoices where tenant_id = old.id)
    or exists(select 1 from public.billing_audit where tenant_id = old.id) then
    raise exception 'TENANT_BILLING_DELETE_BLOCKED' using errcode = '23503';
  end if;

  delete from public.billing_accounts where tenant_id = old.id;
  return old;
end;
$$;

revoke all on function public.cleanup_unused_tenant_billing() from public, anon, authenticated;
grant execute on function public.cleanup_unused_tenant_billing() to service_role;

create trigger tenants_cleanup_unused_billing before delete on public.tenants
for each row execute function public.cleanup_unused_tenant_billing();
