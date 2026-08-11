-- Keep the browser inactivity timeout and the server-side login lease aligned.
-- Otherwise the lease would still expire after 30 minutes and close an
-- otherwise valid four-hour browser session.

alter table public.user_login_leases
  alter column expires_at set default (now() + interval '4 hours');

update public.user_login_leases
set expires_at = heartbeat_at + interval '4 hours'
where expires_at > now()
  and expires_at < heartbeat_at + interval '4 hours';

create or replace function public.claim_user_login(p_client_id uuid)
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
  if current_user_id is null or current_session_id is null or p_client_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, now(), now() + interval '4 hours'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at
  where (
    public.user_login_leases.auth_session_id = excluded.auth_session_id
    and public.user_login_leases.client_id = excluded.client_id
  ) or public.user_login_leases.expires_at <= now()
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

create or replace function public.force_claim_user_login(p_client_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id text := auth.jwt() ->> 'session_id';
begin
  if current_user_id is null or current_session_id is null or p_client_id is null then
    return false;
  end if;

  insert into public.user_login_leases (
    user_id, auth_session_id, client_id, heartbeat_at, expires_at
  ) values (
    current_user_id, current_session_id, p_client_id, now(), now() + interval '4 hours'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at;

  return true;
end;
$$;

create or replace function public.heartbeat_user_login(p_client_id uuid)
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
      expires_at = now() + interval '4 hours'
  where user_id = current_user_id
    and auth_session_id = current_session_id
    and client_id = p_client_id
    and expires_at > now()
  returning true into refreshed;

  return coalesce(refreshed, false);
end;
$$;
