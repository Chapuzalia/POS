-- A login lease represents recent user activity, not the four-hour local session.
-- Keep a stable browser/device id separate from the current tab/PWA instance id.

alter table public.user_login_leases
  add column if not exists device_id uuid;

update public.user_login_leases
set device_id = client_id
where device_id is null;

alter table public.user_login_leases
  alter column device_id set not null,
  alter column expires_at set default (now() + interval '2 minutes');

-- Do not leave old four-hour leases active after this migration is applied.
update public.user_login_leases
set expires_at = least(expires_at, heartbeat_at + interval '2 minutes');

drop function if exists public.claim_user_login(uuid);
drop function if exists public.force_claim_user_login(uuid);
drop function if exists public.heartbeat_user_login(uuid);
drop function if exists public.check_user_login(uuid);
drop function if exists public.release_user_login(uuid);

create function public.claim_user_login(
  p_client_id uuid,
  p_device_id uuid,
  p_allow_same_device boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
  claimed boolean := false;
begin
  if current_user_id is null or current_session_id is null
    or p_client_id is null or p_device_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, device_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, p_device_id,
    now(), now() + interval '2 minutes'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    device_id = excluded.device_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
  where (p_allow_same_device and public.user_login_leases.device_id = excluded.device_id)
     or public.user_login_leases.expires_at <= now()
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create function public.force_claim_user_login(p_client_id uuid, p_device_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
begin
  if current_user_id is null or current_session_id is null
    or p_client_id is null or p_device_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, device_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, p_device_id,
    now(), now() + interval '2 minutes'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    device_id = excluded.device_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at;

  return true;
end;
$$;

create function public.heartbeat_user_login(p_client_id uuid, p_device_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
  refreshed boolean := false;
begin
  update public.user_login_leases
  set heartbeat_at = now(),
      expires_at = now() + interval '2 minutes'
  where user_id = current_user_id
    and auth_session_id = current_session_id
    and client_id = p_client_id
    and device_id = p_device_id
    and expires_at > now()
  returning true into refreshed;

  return coalesce(refreshed, false);
end;
$$;

create function public.check_user_login(p_client_id uuid, p_device_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and (auth.jwt() ->> 'session_id') is not null
    and p_client_id is not null
    and p_device_id is not null
    and (
      exists (
        select 1
        from public.user_login_leases
        where user_id = auth.uid()
          and auth_session_id = (auth.jwt() ->> 'session_id')
          and client_id = p_client_id
          and device_id = p_device_id
          and expires_at > now()
      )
      or not exists (
        select 1
        from public.user_login_leases
        where user_id = auth.uid()
          and expires_at > now()
      )
    );
$$;

create function public.release_user_login(p_client_id uuid, p_device_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.user_login_leases
  where user_id = auth.uid()
    and auth_session_id = (auth.jwt() ->> 'session_id')
    and client_id = p_client_id
    and device_id = p_device_id;
$$;

revoke all on function public.claim_user_login(uuid, uuid, boolean) from public;
revoke all on function public.force_claim_user_login(uuid, uuid) from public;
revoke all on function public.heartbeat_user_login(uuid, uuid) from public;
revoke all on function public.check_user_login(uuid, uuid) from public;
revoke all on function public.release_user_login(uuid, uuid) from public;

grant execute on function public.claim_user_login(uuid, uuid, boolean) to authenticated;
grant execute on function public.force_claim_user_login(uuid, uuid) to authenticated;
grant execute on function public.heartbeat_user_login(uuid, uuid) to authenticated;
grant execute on function public.check_user_login(uuid, uuid) to authenticated;
grant execute on function public.release_user_login(uuid, uuid) to authenticated;
