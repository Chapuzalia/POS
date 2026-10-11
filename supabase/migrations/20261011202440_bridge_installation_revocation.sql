-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New server-only retirement RPC and scoped authenticated status RPC; existing identity, record and activation contracts remain unchanged.

alter table public.fiscal_sif_installations add column bridge_revoked_at timestamptz;
alter table public.fiscal_sif_installations add column bridge_revocation_reason text;

-- Only the bridge's server credential can invoke this operation. It retires
-- exactly the enrolled installation/device bound to that bridge origin.
create function public.fiscal_bridge_revoke_installation(p_installation_id uuid, p_device_id uuid,
  p_bridge_url text, p_reason text, p_revoked_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.fiscal_sif_installations%rowtype; boundary timestamptz;
begin
  if p_revoked_at is null or nullif(btrim(p_reason), '') is null or char_length(btrim(p_reason)) > 500 then
    raise exception 'FISCAL_BRIDGE_REVOCATION_INVALID' using errcode = '22023';
  end if;
  select * into i from public.fiscal_sif_installations where id = p_installation_id for update;
  if i.id is null or not i.bridge_requested or i.device_id is distinct from p_device_id
    or not exists (
      select 1 from public.fiscal_bridge_requests q
      join public.fiscal_pos_bridge_settings c on c.tenant_id = i.tenant_id
      where q.installation_id = i.id
        and nullif(rtrim(coalesce(q.bridge_url, c.bridge_url), '/'), '') = nullif(rtrim(p_bridge_url, '/'), '')
    ) then
    raise exception 'FISCAL_BRIDGE_REVOCATION_FORBIDDEN' using errcode = '42501';
  end if;
  if i.bridge_revoked_at is null then
    -- Retain the bridge's original boundary across delayed/lost acknowledgements.
    -- A future bridge clock must never postpone the server-side retirement.
    boundary := least(p_revoked_at, clock_timestamp());
    update public.fiscal_sif_installations set retired_at = coalesce(retired_at, boundary),
      bridge_revoked_at = boundary, bridge_revocation_reason = btrim(p_reason)
    where id = i.id returning * into i;
  end if;
  return jsonb_build_object('installationId', i.id, 'revokedAt', i.bridge_revoked_at, 'reason', i.bridge_revocation_reason);
end;
$$;
revoke all on function public.fiscal_bridge_revoke_installation(uuid,uuid,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.fiscal_bridge_revoke_installation(uuid,uuid,text,text,timestamptz) to service_role;

create function public.pos_fiscal_installation_revocation(p_tenant_id uuid, p_venue_id uuid,
  p_register_id uuid, p_device_id uuid, p_installation_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('installationId', i.id, 'revokedAt', i.bridge_revoked_at, 'reason', i.bridge_revocation_reason)
  from public.fiscal_sif_installations i
  where auth.uid() is not null and i.id = p_installation_id and i.tenant_id = p_tenant_id
    and i.venue_id = p_venue_id and i.cash_register_id = p_register_id and i.device_id = p_device_id
    and i.retired_at is not null and i.bridge_revoked_at is not null
    and public.user_has_device_access(p_tenant_id, p_venue_id, p_device_id);
$$;
revoke all on function public.pos_fiscal_installation_revocation(uuid,uuid,uuid,uuid,uuid) from public, anon;
grant execute on function public.pos_fiscal_installation_revocation(uuid,uuid,uuid,uuid,uuid) to authenticated;
