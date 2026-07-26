-- Ensure existing projects publish the rows used by the CRM open-cash dashboard.

do $$
declare
  target_table text;
  publishes_all_tables boolean;
begin
  if not exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    execute 'create publication supabase_realtime';
  end if;

  select publication.puballtables
  into publishes_all_tables
  from pg_catalog.pg_publication as publication
  where publication.pubname = 'supabase_realtime';

  if publishes_all_tables then
    return;
  end if;

  foreach target_table in array array['cash_sessions', 'sales', 'tickets']
  loop
    if to_regclass(format('public.%I', target_table)) is not null
      and not exists (
        select 1
        from pg_catalog.pg_publication_tables as published
        where published.pubname = 'supabase_realtime'
          and published.schemaname = 'public'
          and published.tablename = target_table
      )
    then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        target_table
      );
    end if;
  end loop;
end
$$;
