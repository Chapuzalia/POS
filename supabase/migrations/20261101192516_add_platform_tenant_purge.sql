-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New backend-only purge RPCs require a service role and a verified superadmin; trigger helpers expose no tenant data. Normal fiscal and historical guards retain their existing bodies and permissions.

-- No existing data is deleted when this migration is installed.
-- A pending job retains only the references required to resume external cleanup.
create table public.platform_tenant_deletion_jobs (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  request_id uuid not null default gen_random_uuid(),
  stripe_customer_id text,
  stripe_subscription_id text,
  user_ids uuid[] not null default '{}',
  database_purged boolean not null default false
);
alter table public.platform_tenant_deletion_jobs enable row level security;
grant select, insert, update, delete on public.platform_tenant_deletion_jobs to service_role;

create function public.platform_tenant_is_deleting(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.platform_tenant_deletion_jobs where tenant_id=p_tenant_id);
$$;

-- Check SET ROLE, not current_user: some existing guard functions are definers.
-- An authenticated caller cannot impersonate service_role by setting a GUC.
create function public.platform_tenant_purge_allowed(p_tenant_id uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce(current_setting('role',true)='service_role'
    and p_tenant_id::text=current_setting('tickit.purge_tenant',true),false);
$$;

create function public.guard_platform_tenant_deletion_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tid uuid; row_data jsonb; marker text:=current_setting('tickit.purge_tenant',true);
begin
  row_data:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  tid := case when tg_table_name='tenants' then (row_data->>'id')::uuid else (row_data->>'tenant_id')::uuid end;
  if current_setting('role',true)='service_role' and coalesce(marker,'')<>'' and tid::text is distinct from marker then
    raise exception 'TENANT_DELETION_CROSS_TENANT_REFERENCE' using errcode='23503';
  end if;
  if tid is null or public.platform_tenant_purge_allowed(tid) then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  -- Serialize preparation against writes, including service-role background work.
  perform 1 from public.tenants where id=tid for key share;
  if not found then
    -- Existing parent DELETEs still own ordinary FK cascades (N-1 API).
    if tg_op='DELETE' and not public.platform_tenant_is_deleting(tid) then return old; end if;
    raise exception 'TENANT_DELETION_IN_PROGRESS' using errcode='55000';
  end if;
  if public.platform_tenant_is_deleting(tid) then
    raise exception 'TENANT_DELETION_IN_PROGRESS' using errcode='55000';
  end if;
  if tg_table_name='tenant_memberships' then
    if exists(select 1 from public.platform_tenant_deletion_jobs where new.user_id=any(user_ids)) then
      raise exception 'TENANT_DELETION_IN_PROGRESS' using errcode='55000';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create function public.guard_platform_tenant_storage_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare prefix text := split_part(new.name,'/',1); tid uuid;
begin
  if new.bucket_id not in ('product-images','supplier-documents')
    or prefix !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return new; end if;
  tid := prefix::uuid;
  perform 1 from public.tenants where id=tid for key share;
  if not found or public.platform_tenant_is_deleting(tid) then
    raise exception 'TENANT_DELETION_IN_PROGRESS' using errcode='55000';
  end if;
  return new;
end;
$$;
create trigger guard_platform_tenant_storage_write before insert or update on storage.objects
for each row execute function public.guard_platform_tenant_storage_write();

-- Late webhooks must not recreate deleted customer references. The normal event
-- claim/finish path remains unchanged for customers still linked to a tenant.
create function public.guard_deleted_tenant_stripe_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tid uuid;
begin
  select tenant_id into tid from public.billing_accounts where stripe_customer_id=new.stripe_customer_id;
  if tid is null then return null; end if;
  perform 1 from public.tenants where id=tid for key share;
  if not found or public.platform_tenant_is_deleting(tid) then return null; end if;
  return new;
end;
$$;
create trigger guard_deleted_tenant_stripe_event before insert or update on public.billing_stripe_events
for each row execute function public.guard_deleted_tenant_stripe_event();

create function public.guard_platform_tenant_integration_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare row_data jsonb; tid uuid; marker text:=current_setting('tickit.purge_tenant',true);
begin
  if tg_op='DELETE' and coalesce(marker,'')<>'' and public.platform_tenant_purge_allowed(marker::uuid) then return old; end if;
  row_data:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  select tenant_id into tid from tickit_private.integrations where id=(row_data->>'integration_id')::uuid;
  perform 1 from public.tenants where id=tid for key share;
  if not found or public.platform_tenant_is_deleting(tid) then
    raise exception 'TENANT_DELETION_IN_PROGRESS' using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

-- Preserve existing trigger logic inside a nested block (adding a final
-- semicolon when the original top-level block omitted that optional token). Only the
-- explicit service-role purge of the matching tenant bypasses DELETE side effects
-- and immutability guards. Ordinary UPDATE/DELETE calls keep their protections.
do $migration$
declare f record; tab record; wrapped text; original_body text;
begin
  for f in
    select distinct p.oid,p.prosrc,pg_get_functiondef(p.oid) definition,l.lanname
    from pg_trigger t join pg_proc p on p.oid=t.tgfoid join pg_language l on l.oid=p.prolang
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal and (t.tgtype::integer & 8)=8
      and (c.relname='tenants' or exists(select 1 from pg_attribute a
        where a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped))
  loop
    if f.lanname <> 'plpgsql' then raise exception 'TENANT_PURGE_UNSUPPORTED_TRIGGER'; end if;
    original_body:=regexp_replace(f.prosrc,'(\mend\M)\s*$','\1;','i');
    wrapped := 'begin if tg_op=''DELETE'' and public.platform_tenant_purge_allowed('
      || 'case when tg_table_name=''tenants'' then (to_jsonb(old)->>''id'')::uuid '
      || 'else (to_jsonb(old)->>''tenant_id'')::uuid end) then return old; end if; '
      || E'\n' || original_body || E'\nend;';
    execute replace(f.definition,f.prosrc,wrapped);
  end loop;
  for tab in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped
    where n.nspname='public' and c.relkind='r' and a.atttypid='uuid'::regtype
      and c.relname <> 'platform_tenant_deletion_jobs'
  loop
    execute format('create trigger guard_platform_tenant_deletion_write before insert or update or delete on public.%I for each row execute function public.guard_platform_tenant_deletion_write()',tab.relname);
    if exists(select 1 from pg_class where oid=format('public.%I',tab.relname)::regclass and relrowsecurity) then
      execute format('create policy platform_tenant_deletion_access on public.%I as restrictive for all to authenticated using (not public.platform_tenant_is_deleting(tenant_id)) with check (not public.platform_tenant_is_deleting(tenant_id))',tab.relname);
    end if;
  end loop;
  if to_regclass('tickit_private.integrations') is not null then
    create trigger guard_platform_tenant_deletion_write before insert or update or delete on tickit_private.integrations
      for each row execute function public.guard_platform_tenant_deletion_write();
    for tab in select unnest(array['table_links','sessions','requests']) relname loop
      execute format('create trigger guard_platform_tenant_integration_write before insert or update or delete on tickit_private.%I for each row execute function public.guard_platform_tenant_integration_write()',tab.relname);
    end loop;
  end if;
end;
$migration$;
create trigger guard_platform_tenant_deletion_write before update or delete on public.tenants
for each row execute function public.guard_platform_tenant_deletion_write();

create function public.prepare_platform_tenant_deletion(p_tenant_id uuid,p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare job public.platform_tenant_deletion_jobs; account public.billing_accounts; candidates uuid[]; uid uuid; ref record; shared boolean;
begin
  if current_setting('role',true)<>'service_role' or not exists(select 1 from public.profiles where id=p_actor_id and is_superadmin) then
    raise exception 'TENANT_DELETION_FORBIDDEN' using errcode='42501';
  end if;
  perform 1 from public.tenants where id=p_tenant_id for update;
  if not found then return null; end if;
  select * into job from public.platform_tenant_deletion_jobs where tenant_id=p_tenant_id;
  if found then return to_jsonb(job); end if;
  select * into account from public.billing_accounts where tenant_id=p_tenant_id for update;
  if account.sync_until > now() or exists(select 1 from public.billing_operations
    where tenant_id=p_tenant_id and status='applying') then
    raise exception 'TENANT_DELETION_BILLING_BUSY' using errcode='55000';
  end if;
  select coalesce(array_agg(distinct m.user_id),'{}') into candidates from public.tenant_memberships m
    left join public.profiles p on p.id=m.user_id
    where m.tenant_id=p_tenant_id and m.user_id<>p_actor_id and not coalesce(p.is_superadmin,false)
      and not exists(select 1 from public.tenant_memberships other where other.user_id=m.user_id and other.tenant_id<>p_tenant_id);
  -- Membership alone is insufficient: preserve identities used by another
  -- tenant's historical records, even after that membership was removed.
  foreach uid in array candidates loop
    for ref in select distinct ns.nspname,c.relname,a.attname,exists(select 1 from pg_attribute scope
        where scope.attrelid=c.oid and scope.attname='tenant_id' and not scope.attisdropped) scoped
      from pg_constraint fk join pg_class c on c.oid=fk.conrelid join pg_namespace ns on ns.oid=c.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attnum=fk.conkey[1]
      where fk.contype='f' and array_length(fk.conkey,1)=1
        and fk.confrelid in ('public.profiles'::regclass,'auth.users'::regclass)
        and ns.nspname='public' and c.relname not in ('profiles','user_login_leases')
    loop
      execute format('select exists(select 1 from %I.%I where %I=$1 and %s)',ref.nspname,ref.relname,ref.attname,
        case when ref.scoped then 'tenant_id is distinct from $2' else 'true' end)
        into shared using uid,p_tenant_id;
      if shared then candidates:=array_remove(candidates,uid); exit; end if;
    end loop;
    if exists(select 1 from storage.objects o where
      coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=uid::text and o.name not like p_tenant_id::text || '/%') then
      candidates:=array_remove(candidates,uid);
    end if;
  end loop;
  update public.tenants set is_active=false where id=p_tenant_id;
  if to_regclass('tickit_private.integrations') is not null then
    update tickit_private.integrations set enabled=false where tenant_id=p_tenant_id;
  end if;
  insert into public.platform_tenant_deletion_jobs(tenant_id,stripe_customer_id,stripe_subscription_id,user_ids)
    values(p_tenant_id,account.stripe_customer_id,account.stripe_subscription_id,candidates) returning * into job;
  return to_jsonb(job);
end;
$$;

create function public.purge_platform_tenant_private_data(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.platform_tenant_purge_allowed(p_tenant_id) then
    raise exception 'TENANT_DELETION_FORBIDDEN' using errcode='42501';
  end if;
  if to_regclass('tickit_private.integrations') is not null then
    with links as (delete from tickit_private.table_links where integration_id in (select id from tickit_private.integrations where tenant_id=p_tenant_id)),
      sessions as (delete from tickit_private.sessions where integration_id in (select id from tickit_private.integrations where tenant_id=p_tenant_id)),
      requests as (delete from tickit_private.requests where integration_id in (select id from tickit_private.integrations where tenant_id=p_tenant_id))
    delete from tickit_private.integrations where tenant_id=p_tenant_id;
  end if;
end;
$$;

create function public.list_platform_tenant_deletion_objects(p_tenant_id uuid) returns table(bucket_id text,name text)
language sql stable security invoker set search_path = '' as $$
  select o.bucket_id,o.name from storage.objects o
    where current_user='service_role' and public.platform_tenant_is_deleting(p_tenant_id)
      and o.name like p_tenant_id::text || '/%' order by o.bucket_id,o.name limit 200;
$$;

create function public.purge_platform_tenant_data(p_tenant_id uuid,p_actor_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare job public.platform_tenant_deletion_jobs; tab record; statements text:=''; remaining boolean; previous_marker text;
begin
  if current_user <> 'service_role' or not exists(select 1 from public.profiles where id=p_actor_id and is_superadmin) then
    raise exception 'TENANT_DELETION_FORBIDDEN' using errcode='42501';
  end if;
  perform 1 from public.tenants where id=p_tenant_id for update;
  select * into strict job from public.platform_tenant_deletion_jobs where tenant_id=p_tenant_id for update;
  if job.database_purged then return; end if;
  if exists(select 1 from storage.objects where name like p_tenant_id::text || '/%') then
    raise exception 'TENANT_DELETION_STORAGE_PENDING' using errcode='55000';
  end if;
  -- A later schema change must install the tenant fence and adapt any new
  -- DELETE trigger before that table participates in a complete purge.
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped
    where n.nspname='public' and c.relkind='r' and a.atttypid='uuid'::regtype
      and c.relname<>'platform_tenant_deletion_jobs' and not exists(select 1 from pg_trigger t
        where t.tgrelid=c.oid and t.tgname='guard_platform_tenant_deletion_write' and t.tgenabled='O')) then
    raise exception 'TENANT_DELETION_SCHEMA_REVIEW_REQUIRED' using errcode='55000';
  end if;
  previous_marker:=current_setting('tickit.purge_tenant',true);
  -- Deferred custom constraint triggers must run before the purge marker is reset.
  set constraints all immediate;
  perform set_config('tickit.purge_tenant',p_tenant_id::text,true);
  perform public.purge_platform_tenant_private_data(p_tenant_id);
  -- All deletions share one SQL statement/snapshot. RESTRICT constraints and
  -- cycles between tickets/sales/orders are checked after every CTE has run.
  for tab in select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped
    where n.nspname='public' and c.relkind='r' and a.atttypid='uuid'::regtype
      and c.relname <> 'platform_tenant_deletion_jobs' order by c.relname
  loop
    statements:=statements || format('d_%s as (delete from public.%I where tenant_id=$1 returning 1),',tab.oid,tab.relname);
  end loop;
  if to_regclass('public.fiscal_bridge_requests') is not null then
    statements:=statements || 'd_bridge as (delete from public.fiscal_bridge_requests where installation_id in (select id from public.fiscal_sif_installations where tenant_id=$1) returning 1),';
  end if;
  statements:=statements || 'd_events as (delete from public.billing_stripe_events where stripe_customer_id=$2 returning 1)';
  execute 'with ' || statements || ' select 1' using p_tenant_id,job.stripe_customer_id;
  for tab in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped
    where n.nspname='public' and c.relkind='r' and a.atttypid='uuid'::regtype and c.relname<>'platform_tenant_deletion_jobs'
  loop
    execute format('select exists(select 1 from public.%I where tenant_id=$1)',tab.relname) into remaining using p_tenant_id;
    if remaining then raise exception 'TENANT_DELETION_INCOMPLETE'; end if;
  end loop;
  update public.platform_tenant_deletion_jobs set database_purged=true where tenant_id=p_tenant_id;
  perform set_config('tickit.purge_tenant',coalesce(previous_marker,''),true);
end;
$$;

create function public.ack_platform_tenant_deleted_user(p_tenant_id uuid,p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('role',true)<>'service_role' then
    raise exception 'TENANT_DELETION_FORBIDDEN' using errcode='42501';
  end if;
  perform 1 from public.tenants where id=p_tenant_id for update;
  perform 1 from public.platform_tenant_deletion_jobs where tenant_id=p_tenant_id and database_purged for update;
  if not found then raise exception 'TENANT_DELETION_INCOMPLETE' using errcode='55000'; end if;
  if exists(select 1 from auth.users where id=p_user_id) then
    raise exception 'TENANT_DELETION_INCOMPLETE' using errcode='55000';
  end if;
  update public.platform_tenant_deletion_jobs set user_ids=array_remove(user_ids,p_user_id) where tenant_id=p_tenant_id;
end;
$$;

create function public.finish_platform_tenant_deletion(p_tenant_id uuid,p_actor_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare job public.platform_tenant_deletion_jobs; previous_marker text;
begin
  if current_setting('role',true)<>'service_role' or not exists(select 1 from public.profiles where id=p_actor_id and is_superadmin) then
    raise exception 'TENANT_DELETION_FORBIDDEN' using errcode='42501';
  end if;
  perform 1 from public.tenants where id=p_tenant_id for update;
  select * into job from public.platform_tenant_deletion_jobs where tenant_id=p_tenant_id for update;
  if not found then return; end if;
  if not job.database_purged or cardinality(job.user_ids)>0
    or exists(select 1 from storage.objects where name like p_tenant_id::text || '/%') then
    raise exception 'TENANT_DELETION_INCOMPLETE' using errcode='55000';
  end if;
  previous_marker:=current_setting('tickit.purge_tenant',true);
  perform set_config('tickit.purge_tenant',p_tenant_id::text,true);
  delete from public.tenants where id=p_tenant_id;
  perform set_config('tickit.purge_tenant',coalesce(previous_marker,''),true);
end;
$$;

revoke all on function public.platform_tenant_is_deleting(uuid),public.platform_tenant_purge_allowed(uuid) from public,anon;
grant execute on function public.platform_tenant_is_deleting(uuid),public.platform_tenant_purge_allowed(uuid) to authenticated,service_role;
revoke all on function public.guard_platform_tenant_integration_write(),public.purge_platform_tenant_private_data(uuid) from public,anon,authenticated;
grant execute on function public.guard_platform_tenant_integration_write(),public.purge_platform_tenant_private_data(uuid) to service_role;
revoke all on function public.guard_platform_tenant_deletion_write(),public.guard_platform_tenant_storage_write(),public.guard_deleted_tenant_stripe_event(),public.prepare_platform_tenant_deletion(uuid,uuid),public.list_platform_tenant_deletion_objects(uuid),public.purge_platform_tenant_data(uuid,uuid),public.ack_platform_tenant_deleted_user(uuid,uuid),public.finish_platform_tenant_deletion(uuid,uuid) from public,anon,authenticated;
grant execute on function public.guard_platform_tenant_deletion_write(),public.guard_platform_tenant_storage_write(),public.guard_deleted_tenant_stripe_event(),public.prepare_platform_tenant_deletion(uuid,uuid),public.list_platform_tenant_deletion_objects(uuid),public.purge_platform_tenant_data(uuid,uuid),public.ack_platform_tenant_deleted_user(uuid,uuid),public.finish_platform_tenant_deletion(uuid,uuid) to service_role;
