begin;

create or replace function public.validate_final_catalog_scope()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='products' and new.category_id is not null and not exists(select 1 from public.categories c where c.id=new.category_id and c.tenant_id=new.tenant_id and (c.venue_id is null or c.venue_id=new.venue_id)) then raise exception 'PRODUCT_CATEGORY_SCOPE_MISMATCH'; end if;
  if tg_table_name='product_variants' and not exists(select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id) then raise exception 'VARIANT_PRODUCT_SCOPE_MISMATCH'; end if;
  if tg_table_name='catalog_placements' then
    if not exists(select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id) then raise exception 'PLACEMENT_PRODUCT_SCOPE_MISMATCH'; end if;
    if not exists(select 1 from public.catalog_tabs t where t.id=new.tab_id and t.tenant_id=new.tenant_id and t.venue_id=new.venue_id) then raise exception 'PLACEMENT_TAB_SCOPE_MISMATCH'; end if;
    if new.category_id is not null and not exists(select 1 from public.categories c where c.id=new.category_id and c.tenant_id=new.tenant_id and c.venue_id=new.venue_id) then raise exception 'PLACEMENT_CATEGORY_SCOPE_MISMATCH'; end if;
    if new.variant_id is not null and not exists(select 1 from public.product_variants v where v.id=new.variant_id and v.product_id=new.product_id and v.tenant_id=new.tenant_id and v.venue_id=new.venue_id) then raise exception 'PLACEMENT_VARIANT_PRODUCT_MISMATCH'; end if;
  end if;
  if tg_table_name='modifier_groups' and new.product_id is not null and not exists(select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id) then raise exception 'MODIFIER_GROUP_PRODUCT_SCOPE_MISMATCH'; end if;
  if tg_table_name='modifiers' and not exists(select 1 from public.modifier_groups g where g.id=new.group_id and g.tenant_id=new.tenant_id and g.venue_id=new.venue_id) then raise exception 'MODIFIER_GROUP_SCOPE_MISMATCH'; end if;
  return new;
end $$;

do $$ declare t text;
begin
  foreach t in array array['products','product_variants','catalog_placements','modifier_groups','modifiers'] loop
    execute format('drop trigger if exists %I on public.%I',t||'_final_scope',t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.validate_final_catalog_scope()',t||'_final_scope',t);
  end loop;
end $$;

create or replace function public.validate_modifier_capacity()
returns trigger language plpgsql set search_path='' as $$
declare v_group uuid:=coalesce(new.group_id,old.group_id); v_bad uuid;
begin
  select a.id into v_bad from public.product_modifier_group_assignments a
  where a.group_id=v_group and a.is_active and a.min_selection>(select count(*) from public.modifiers m where m.group_id=a.group_id and m.is_active)
  limit 1;
  if v_bad is not null then raise exception 'INSUFFICIENT_ACTIVE_MODIFIER_CAPACITY assignment %',v_bad; end if;
  return null;
end $$;

drop trigger if exists modifiers_capacity_guard on public.modifiers;
create constraint trigger modifiers_capacity_guard after insert or update or delete on public.modifiers deferrable initially deferred for each row execute function public.validate_modifier_capacity();
drop trigger if exists modifier_assignments_capacity_guard on public.product_modifier_group_assignments;
create constraint trigger modifier_assignments_capacity_guard after insert or update or delete on public.product_modifier_group_assignments deferrable initially deferred for each row execute function public.validate_modifier_capacity();

commit;
