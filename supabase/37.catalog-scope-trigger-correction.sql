begin;

create or replace function public.validate_final_catalog_scope()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='products' then
    if new.category_id is not null and not exists(select 1 from public.categories c where c.id=new.category_id and c.tenant_id=new.tenant_id and (c.venue_id is null or c.venue_id=new.venue_id)) then raise exception 'PRODUCT_CATEGORY_SCOPE_MISMATCH'; end if;
  elsif tg_table_name='product_variants' then
    if not exists(select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id) then raise exception 'VARIANT_PRODUCT_SCOPE_MISMATCH'; end if;
  elsif tg_table_name='catalog_placements' then
    if not exists(select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id) then raise exception 'PLACEMENT_PRODUCT_SCOPE_MISMATCH'; end if;
    if not exists(select 1 from public.catalog_tabs t where t.id=new.tab_id and t.tenant_id=new.tenant_id and t.venue_id=new.venue_id) then raise exception 'PLACEMENT_TAB_SCOPE_MISMATCH'; end if;
    if new.category_id is not null and not exists(select 1 from public.categories c where c.id=new.category_id and c.tenant_id=new.tenant_id and c.venue_id=new.venue_id) then raise exception 'PLACEMENT_CATEGORY_SCOPE_MISMATCH'; end if;
    if new.variant_id is not null and not exists(select 1 from public.product_variants v where v.id=new.variant_id and v.product_id=new.product_id and v.tenant_id=new.tenant_id and v.venue_id=new.venue_id) then raise exception 'PLACEMENT_VARIANT_PRODUCT_MISMATCH'; end if;
  elsif tg_table_name='modifier_groups' then
    if new.product_id is not null and not exists(select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id) then raise exception 'MODIFIER_GROUP_PRODUCT_SCOPE_MISMATCH'; end if;
  elsif tg_table_name='modifiers' then
    if not exists(select 1 from public.modifier_groups g where g.id=new.group_id and g.tenant_id=new.tenant_id and g.venue_id=new.venue_id) then raise exception 'MODIFIER_GROUP_SCOPE_MISMATCH'; end if;
  end if;
  return new;
end $$;

commit;
