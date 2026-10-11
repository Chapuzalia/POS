-- migration-safety: expand
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New internal trigger and scoped RPCs; retains all deployed APIs and historical installations.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Existing identities stay local. Only INSERTs after this migration opt in.
alter table public.fiscal_sif_installations add column bridge_requested boolean default false;
create table public.fiscal_bridge_requests (
  sequence bigint generated always as identity primary key,
  installation_id uuid not null unique references public.fiscal_sif_installations(id) on delete restrict,
  bridge_url text,
  provisioned_at timestamptz,
  created_at timestamptz not null default now()
);
create index fiscal_bridge_requests_pending_idx on public.fiscal_bridge_requests(sequence) where provisioned_at is null;
alter table public.fiscal_bridge_requests enable row level security;
grant select, update on public.fiscal_bridge_requests to service_role;

create function public.fiscal_bridge_identity_marker() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then new.bridge_requested := true;
  elsif new.bridge_requested is distinct from old.bridge_requested then
    raise exception 'FISCAL_BRIDGE_IDENTITY_IMMUTABLE' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger fiscal_bridge_identity_marker before insert or update on public.fiscal_sif_installations
for each row execute function public.fiscal_bridge_identity_marker();

-- Transactional outbox: no HTTP request while the POS database is locked.
create function public.fiscal_bridge_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.fiscal_bridge_requests(installation_id, bridge_url)
    values(new.id, (select bridge_url from public.fiscal_pos_bridge_settings where tenant_id=new.tenant_id));
  return new;
end;
$$;
revoke all on function public.fiscal_bridge_enqueue(), public.fiscal_bridge_identity_marker() from public, anon, authenticated;
create trigger fiscal_bridge_enqueue after insert on public.fiscal_sif_installations
for each row execute function public.fiscal_bridge_enqueue();

create function public.fiscal_bridge_pending(p_bridge_url text, p_after bigint default 0)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(row_data order by sequence), '[]'::jsonb) from (
    select q.sequence, jsonb_build_object('sequence',q.sequence,'installation',to_jsonb(i),'subject',to_jsonb(s)) as row_data
    from public.fiscal_bridge_requests q
    join public.fiscal_sif_installations i on i.id=q.installation_id
    join public.fiscal_subjects s on s.id=i.fiscal_subject_id and s.tenant_id=i.tenant_id
    join public.fiscal_pos_bridge_settings c on c.tenant_id=i.tenant_id
    where q.provisioned_at is null and q.sequence>p_after and i.mode='production'
      and rtrim(coalesce(q.bridge_url,c.bridge_url),'/')=rtrim(p_bridge_url,'/')
    order by q.sequence limit 100
  ) pending;
$$;
create function public.fiscal_bridge_ack(p_installation_id uuid, p_bridge_url text)
returns void language sql security definer set search_path = '' as $$
  update public.fiscal_bridge_requests q set provisioned_at=coalesce(q.provisioned_at,now()), bridge_url=p_bridge_url
  from public.fiscal_sif_installations i, public.fiscal_pos_bridge_settings c
  where q.installation_id=p_installation_id and i.id=q.installation_id and c.tenant_id=i.tenant_id
    and rtrim(coalesce(q.bridge_url,c.bridge_url),'/')=rtrim(p_bridge_url,'/');
$$;
revoke all on function public.fiscal_bridge_pending(text,bigint), public.fiscal_bridge_ack(uuid,text) from public, anon, authenticated;
grant execute on function public.fiscal_bridge_pending(text,bigint), public.fiscal_bridge_ack(uuid,text) to service_role;

-- Supabase validates the user JWT; authorization is checked against current DB permissions.
-- Retired identities may reconcile their own history but cannot acquire an emission lease.
create function public.fiscal_bridge_authorize(p_installation_id uuid, p_bridge_url text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('installation',to_jsonb(i),'subject',to_jsonb(s),'aeatEnvironment',c.aeat_environment)
  from public.fiscal_sif_installations i
  join public.fiscal_subjects s on s.id=i.fiscal_subject_id and s.tenant_id=i.tenant_id
  join public.fiscal_pos_bridge_settings c on c.tenant_id=i.tenant_id
  where auth.uid() is not null and i.id=p_installation_id and i.bridge_requested
    and rtrim(c.bridge_url,'/')=rtrim(p_bridge_url,'/')
    and public.user_has_device_access(i.tenant_id,i.venue_id,i.device_id)
    and exists(select 1 from public.devices d where d.id=i.device_id and d.tenant_id=i.tenant_id
      and d.venue_id=i.venue_id and d.is_active and d.can_take_payments);
$$;
create function public.fiscal_bridge_confirm_record(p_installation_id uuid,p_record_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('record',r.record_envelope,'snapshot',r.invoice_snapshot,'reason',r.economic_snapshot->>'reason')
  from public.fiscal_local_records r join public.fiscal_sif_installations i on i.id=r.installation_id and i.tenant_id=r.tenant_id
  where auth.uid() is not null and i.id=p_installation_id and i.bridge_requested and r.id=p_record_id
    and public.user_has_device_access(i.tenant_id,i.venue_id,i.device_id);
$$;
revoke all on function public.fiscal_bridge_authorize(uuid,text), public.fiscal_bridge_confirm_record(uuid,uuid) from public, anon;
grant execute on function public.fiscal_bridge_authorize(uuid,text), public.fiscal_bridge_confirm_record(uuid,uuid) to authenticated;
