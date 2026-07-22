-- Permite que los TPV abiertos reciban cambios de nombre, icono, estado y orden
-- realizados sobre las pestañas desde el CRM.

begin;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) then
    execute 'create publication supabase_realtime';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'catalog_tabs'
  ) then
    alter publication supabase_realtime add table public.catalog_tabs;
  end if;
end
$$;

commit;
