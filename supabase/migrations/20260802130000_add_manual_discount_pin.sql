-- Optional PIN protection for the free-form manual discount.

alter table public.venues
  add column if not exists manual_discount_requires_pin boolean not null default false;

create table if not exists public.manual_discount_secrets (
  venue_id uuid primary key references public.venues(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.manual_discount_pin_grants (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists manual_discount_pin_grants_lookup_idx
  on public.manual_discount_pin_grants(user_id, venue_id, expires_at);

alter table public.manual_discount_secrets enable row level security;
alter table public.manual_discount_pin_grants enable row level security;

-- Secrets and grants are available only through the security-definer functions below.
revoke all on public.manual_discount_secrets from anon, authenticated;
revoke all on public.manual_discount_pin_grants from anon, authenticated;

create or replace function public.update_manual_discount_settings(
  p_venue_id uuid,
  p_enabled boolean,
  p_requires_pin boolean,
  p_pin text default null
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  tenant_id_value uuid;
begin
  select v.tenant_id into tenant_id_value
  from public.venues v
  where v.id = p_venue_id;

  if tenant_id_value is null or not public.user_is_tenant_admin(tenant_id_value) then
    raise exception 'No puedes configurar el descuento manual de este local' using errcode = '42501';
  end if;

  if p_pin is not null and p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'El PIN debe contener entre 4 y 8 dígitos';
  end if;

  if not p_requires_pin then
    delete from public.manual_discount_secrets where venue_id = p_venue_id;
  elsif p_pin is not null then
    insert into public.manual_discount_secrets(venue_id, tenant_id, pin_hash, updated_at)
    values (
      p_venue_id,
      tenant_id_value,
      extensions.crypt(p_pin, extensions.gen_salt('bf', 10)),
      now()
    )
    on conflict (venue_id) do update
      set pin_hash = excluded.pin_hash,
          tenant_id = excluded.tenant_id,
          updated_at = now();
  elsif not exists (
    select 1 from public.manual_discount_secrets s where s.venue_id = p_venue_id
  ) then
    raise exception 'Configura un PIN de entre 4 y 8 dígitos';
  end if;

  update public.venues
  set manual_discount_enabled = p_enabled,
      manual_discount_requires_pin = p_requires_pin,
      updated_at = now()
  where id = p_venue_id and tenant_id = tenant_id_value;
end;
$$;

create or replace function public.validate_manual_discount_pin(
  p_venue_id uuid,
  p_pin text
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  venue_row public.venues%rowtype;
  secret_hash text;
begin
  if p_pin !~ '^[0-9]{4,8}$' then return false; end if;

  select v.* into venue_row
  from public.venues v
  where v.id = p_venue_id;

  if venue_row.id is null
    or not venue_row.manual_discount_enabled
    or not venue_row.manual_discount_requires_pin
    or not public.user_has_venue_access(venue_row.tenant_id, venue_row.id)
  then
    return false;
  end if;

  select s.pin_hash into secret_hash
  from public.manual_discount_secrets s
  where s.venue_id = p_venue_id;

  if secret_hash is null or extensions.crypt(p_pin, secret_hash) <> secret_hash then
    return false;
  end if;

  delete from public.manual_discount_pin_grants
  where user_id = auth.uid() and venue_id = p_venue_id;

  insert into public.manual_discount_pin_grants(venue_id, tenant_id, user_id, expires_at)
  values (p_venue_id, venue_row.tenant_id, auth.uid(), now() + interval '5 minutes');

  return true;
end;
$$;

create or replace function public.enforce_manual_discount_pin()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  requires_pin boolean;
  grant_id uuid;
begin
  if new.discount_type is distinct from 'manual' then
    return new;
  end if;

  select v.manual_discount_requires_pin into requires_pin
  from public.venues v
  where v.id = new.venue_id and v.tenant_id = new.tenant_id;

  if coalesce(requires_pin, false) then
    delete from public.manual_discount_pin_grants g
    where g.id = (
      select g2.id
      from public.manual_discount_pin_grants g2
      where g2.user_id = auth.uid()
        and g2.venue_id = new.venue_id
        and g2.tenant_id = new.tenant_id
        and g2.expires_at > now()
      order by g2.created_at desc
      limit 1
    )
    returning g.id into grant_id;

    if grant_id is null then
      raise exception 'La validación del PIN del descuento manual ha caducado';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_manual_discount_pin_trigger on public.tickets;
create trigger enforce_manual_discount_pin_trigger
before insert on public.tickets
for each row execute function public.enforce_manual_discount_pin();

revoke all on function public.update_manual_discount_settings(uuid, boolean, boolean, text) from public;
grant execute on function public.update_manual_discount_settings(uuid, boolean, boolean, text) to authenticated;
revoke all on function public.validate_manual_discount_pin(uuid, text) from public;
grant execute on function public.validate_manual_discount_pin(uuid, text) to authenticated;
revoke all on function public.enforce_manual_discount_pin() from public;
