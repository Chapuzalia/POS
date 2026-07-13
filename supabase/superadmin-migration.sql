-- Administracion global de tenants y sus usuarios owner.
-- La cuenta Auth inicial debe crearse antes en Supabase Authentication.

begin;

alter table public.profiles
add column if not exists is_superadmin boolean not null default false;

create index if not exists profiles_superadmin_idx
on public.profiles (id)
where is_superadmin = true;

create or replace function public.user_is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.is_superadmin = true
  );
$$;

revoke all on function public.user_is_superadmin() from public;
grant execute on function public.user_is_superadmin() to authenticated;

-- Impide que un usuario autenticado modifique su propio indicador global.
-- Los perfiles se crean y actualizan desde la Edge Function con service_role.
drop policy if exists "profiles_self_upsert" on public.profiles;

commit;

-- ACTIVAR LA PRIMERA CUENTA SUPERADMIN
-- 1. Crea el usuario y su contrasena en Authentication > Users.
-- 2. Sustituye el email y ejecuta solamente este bloque:
--
-- insert into public.profiles (id, full_name, is_superadmin)
-- select id, coalesce(raw_user_meta_data ->> 'full_name', email), true
-- from auth.users
-- where lower(email) = lower('superadmin@tu-dominio.com')
-- on conflict (id) do update
-- set full_name = excluded.full_name,
--     is_superadmin = true;
