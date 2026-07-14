-- Permite que una cuenta autenticada sustituya explicitamente su propio lease
-- despues de que el usuario confirme el cierre de la sesion anterior.

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
    current_user_id, current_session_id, p_client_id, now(), now() + interval '30 minutes'
  )
  on conflict (user_id) do update set
    auth_session_id = excluded.auth_session_id,
    client_id = excluded.client_id,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at;

  return true;
end;
$$;

revoke all on function public.force_claim_user_login(uuid) from public;
grant execute on function public.force_claim_user_login(uuid) to authenticated;
