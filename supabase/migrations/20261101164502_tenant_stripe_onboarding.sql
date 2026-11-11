-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserve signatures, grants and existing/manual tenant behavior; gate only explicitly pending new tenants. Revoke anonymous helper access and reserve draft writes for the service role.
-- Preserve the existing admin signature and roles. Only explicitly pending new
-- tenants are denied operational access; existing/manual tenants keep N-1 behavior.
-- New helpers are unavailable to anonymous callers; authenticated keeps EXECUTE.

alter table public.tenants add column billing_activation_required boolean default false;
alter table public.billing_accounts add column onboarding_contract jsonb;

create schema if not exists billing_private;
grant usage on schema billing_private to authenticated, service_role;

create function billing_private.can_operate(target_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.tenants t where t.id=target_tenant
      and not coalesce(t.billing_activation_required,false)
      and (exists(select 1 from public.tenant_memberships tm where tm.tenant_id=t.id and tm.user_id=auth.uid() and tm.is_active)
        or exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_superadmin))
  );
$$;
revoke all on function billing_private.can_operate(uuid) from public, anon;
grant execute on function billing_private.can_operate(uuid) to authenticated, service_role;

-- Evaluate the deny-list once per statement, including large POS/CRM reads.
-- Existing permissive policies still own tenant and venue isolation.
create function billing_private.pending_tenant_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select array(select tm.tenant_id from public.tenant_memberships tm
    join public.tenants t on t.id=tm.tenant_id
    where auth.uid() is not null and tm.user_id=auth.uid() and tm.is_active and t.billing_activation_required);
$$;
revoke all on function billing_private.pending_tenant_ids() from public, anon;
grant execute on function billing_private.pending_tenant_ids() to authenticated, service_role;

create or replace function public.user_is_tenant_admin(target_tenant uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select billing_private.can_operate(target_tenant) and exists (
    select 1 from public.tenant_memberships tm where tm.tenant_id=target_tenant
      and tm.user_id=auth.uid() and tm.role=any(array['owner','manager']) and tm.is_active
  );
$$;

-- Security-definer business RPCs use these helpers and must enforce the same gate.
-- user_has_tenant_access remains unchanged so login can read its own tenant.
create or replace function public.user_has_tenant_role(target_tenant uuid, allowed_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select billing_private.can_operate(target_tenant) and exists (
    select 1 from public.tenant_memberships tm join public.tenants t on t.id=tm.tenant_id
    where tm.tenant_id=target_tenant and tm.user_id=auth.uid()
      and tm.role=any(allowed_roles) and tm.is_active and t.is_active
  );
$$;
create or replace function public.user_has_device_access(target_tenant uuid,target_venue uuid,target_device uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select billing_private.can_operate(target_tenant) and exists (
    select 1 from public.device_user_assignments dua join public.tenant_memberships tm
      on tm.tenant_id=dua.tenant_id and tm.user_id=dua.user_id
    where dua.tenant_id=target_tenant and dua.venue_id=target_venue and dua.device_id=target_device
      and dua.user_id=auth.uid() and dua.is_active and tm.is_active and tm.role='cashier'
  );
$$;
create or replace function public.user_has_venue_access(target_tenant uuid,target_venue uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select billing_private.can_operate(target_tenant) and exists (
    select 1 from public.device_user_assignments dua join public.tenant_memberships tm
      on tm.tenant_id=dua.tenant_id and tm.user_id=dua.user_id
    where dua.tenant_id=target_tenant and dua.venue_id=target_venue
      and dua.user_id=auth.uid() and dua.is_active and tm.is_active and tm.role='cashier'
  );
$$;

-- Login can read its tenant and membership while all business tables are gated.
-- Restrictive policies also cover legacy permissive policies without replacing them.
do $$
declare tab record;
begin
  for tab in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped
    where n.nspname='public' and c.relkind='r' and c.relrowsecurity
      and c.relname not like 'billing_%' and c.relname <> 'tenant_memberships'
  loop
    execute format('create policy billing_activation_access on public.%I as restrictive for all to authenticated using (tenant_id <> all((select billing_private.pending_tenant_ids())::uuid[])) with check (tenant_id <> all((select billing_private.pending_tenant_ids())::uuid[]))',tab.relname);
  end loop;
end;
$$;

create policy billing_activation_membership_insert on public.tenant_memberships as restrictive for insert to authenticated with check (billing_private.can_operate(tenant_id));
create policy billing_activation_membership_update on public.tenant_memberships as restrictive for update to authenticated using (billing_private.can_operate(tenant_id)) with check (billing_private.can_operate(tenant_id));
create policy billing_activation_membership_delete on public.tenant_memberships as restrictive for delete to authenticated using (billing_private.can_operate(tenant_id));
create policy billing_activation_tenant_update on public.tenants as restrictive for update to authenticated using (billing_private.can_operate(id)) with check (billing_private.can_operate(id));

create function public.get_current_billing_access(p_tenant_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.tenant_memberships where tenant_id=p_tenant_id and user_id=auth.uid() and is_active) then
    raise exception 'BILLING_FORBIDDEN' using errcode='42501';
  end if;
  return coalesce((select billing_activation_required from public.tenants where id=p_tenant_id),false);
end;
$$;
revoke all on function public.get_current_billing_access(uuid) from public, anon;
grant execute on function public.get_current_billing_access(uuid) to authenticated, service_role;

create function billing_private.guard_activation() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.billing_activation_required is distinct from old.billing_activation_required
    and current_user not in ('service_role','postgres','supabase_admin') then
    raise exception 'BILLING_FORBIDDEN' using errcode='42501';
  end if;
  return new;
end;
$$;
create trigger billing_guard_activation before update on public.tenants for each row execute function billing_private.guard_activation();

create function billing_private.activate_paid_tenant() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user in ('service_role','postgres','supabase_admin') and new.source='stripe'
    and new.contract is not null and new.status='active' and new.last_payment_status='paid'
    and new.stripe_customer_id is not null and new.stripe_subscription_id is not null then
    update public.tenants set billing_activation_required=false where id=new.tenant_id and billing_activation_required;
  end if;
  return new;
end;
$$;
create trigger billing_activate_paid_tenant after update on public.billing_accounts for each row execute function billing_private.activate_paid_tenant();

-- Draft edits invalidate quotes and serialize against economic changes.
create function public.billing_save_onboarding(p_tenant_id uuid,p_contract jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if current_user not in ('service_role','postgres','supabase_admin') then raise exception 'BILLING_FORBIDDEN'; end if;
  perform 1 from public.billing_accounts where tenant_id=p_tenant_id for update;
  if not exists(select 1 from public.tenants where id=p_tenant_id and billing_activation_required)
    or exists(select 1 from public.billing_operations where tenant_id=p_tenant_id and status in ('applying','payment_pending','scheduled')) then
    raise exception 'BILLING_PENDING_CHANGE';
  end if;
  update public.billing_accounts set onboarding_contract=p_contract,revision=revision+1,updated_at=now() where tenant_id=p_tenant_id;
end;
$$;
revoke all on function public.billing_save_onboarding(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.billing_save_onboarding(uuid,jsonb) to service_role;
