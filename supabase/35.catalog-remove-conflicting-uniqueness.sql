begin;

do $$ declare v_constraint text;
begin
  select conname into v_constraint from pg_constraint
  where conrelid='public.catalog_placements'::regclass and contype='u'
    and pg_get_constraintdef(oid)='UNIQUE (tenant_id, venue_id, tab_id, category_id, product_id)';
  if v_constraint is not null then execute format('alter table public.catalog_placements drop constraint %I',v_constraint); end if;

  select conname into v_constraint from pg_constraint
  where conrelid='public.selection_groups'::regclass and contype='u'
    and pg_get_constraintdef(oid)='UNIQUE (tenant_id, venue_id, kind, name)';
  if v_constraint is not null then execute format('alter table public.selection_groups drop constraint %I',v_constraint); end if;
end $$;

commit;
