create table if not exists public.manager_venue_assignments (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tenant_id, manager_user_id, venue_id)
);

create index if not exists manager_venue_assignments_user_idx
  on public.manager_venue_assignments(manager_user_id, tenant_id);

create or replace function public.validate_manager_venue_assignment()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = new.tenant_id
      and tm.user_id = new.manager_user_id
      and tm.role = 'manager'
      and tm.is_active = true
  ) then
    raise exception 'MANAGER_MEMBERSHIP_REQUIRED' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.venues v
    where v.id = new.venue_id
      and v.tenant_id = new.tenant_id
      and v.is_active = true
  ) then
    raise exception 'MANAGER_VENUE_SCOPE_MISMATCH' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_manager_venue_assignment on public.manager_venue_assignments;
create trigger validate_manager_venue_assignment
before insert or update on public.manager_venue_assignments
for each row execute function public.validate_manager_venue_assignment();

alter table public.manager_venue_assignments enable row level security;

drop policy if exists manager_venue_assignments_select on public.manager_venue_assignments;
create policy manager_venue_assignments_select
on public.manager_venue_assignments
for select
to authenticated
using (
  manager_user_id = (select auth.uid())
  or public.user_has_tenant_role(tenant_id, array['owner'::text])
);

drop policy if exists manager_venue_assignments_owner_manage on public.manager_venue_assignments;
create policy manager_venue_assignments_owner_manage
on public.manager_venue_assignments
for all
to authenticated
using (public.user_has_tenant_role(tenant_id, array['owner'::text]))
with check (public.user_has_tenant_role(tenant_id, array['owner'::text]));

revoke all on table public.manager_venue_assignments from public, anon;
grant select, insert, update, delete on table public.manager_venue_assignments to authenticated;
grant all on table public.manager_venue_assignments to service_role;

create or replace function public.set_manager_venue_assignments(
  p_tenant_id uuid,
  p_manager_user_id uuid,
  p_venue_ids uuid[]
)
returns uuid[]
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_venue_ids uuid[];
begin
  if auth.role() <> 'service_role'
    and not public.user_has_tenant_role(p_tenant_id, array['owner'::text])
  then
    raise exception 'MANAGER_SCOPE_FORBIDDEN' using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct venue_id), array[]::uuid[])
  into v_venue_ids
  from unnest(coalesce(p_venue_ids, array[]::uuid[])) as ids(venue_id);

  if cardinality(v_venue_ids) = 0 then
    raise exception 'MANAGER_SCOPE_EMPTY' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.tenant_memberships tm
    where tm.tenant_id = p_tenant_id
      and tm.user_id = p_manager_user_id
      and tm.role = 'manager'
      and tm.is_active = true
  ) then
    raise exception 'MANAGER_MEMBERSHIP_REQUIRED' using errcode = '22023';
  end if;
  if (
    select count(*) from public.venues v
    where v.tenant_id = p_tenant_id and v.id = any(v_venue_ids) and v.is_active = true
  ) <> cardinality(v_venue_ids) then
    raise exception 'MANAGER_VENUE_SCOPE_MISMATCH' using errcode = '22023';
  end if;

  delete from public.manager_venue_assignments
  where tenant_id = p_tenant_id and manager_user_id = p_manager_user_id;

  insert into public.manager_venue_assignments(tenant_id, manager_user_id, venue_id)
  select p_tenant_id, p_manager_user_id, venue_id
  from unnest(v_venue_ids) as ids(venue_id);

  return v_venue_ids;
end;
$$;

revoke all on function public.set_manager_venue_assignments(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.set_manager_venue_assignments(uuid, uuid, uuid[]) to authenticated, service_role;
