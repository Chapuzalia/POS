begin;

revoke all on public.categories, public.products, public.product_variants,
  public.catalog_tabs, public.catalog_placements, public.selection_groups,
  public.modifier_groups, public.modifiers from anon;

grant select on public.categories, public.products, public.product_variants,
  public.catalog_tabs, public.catalog_placements, public.selection_groups,
  public.modifier_groups, public.modifiers to authenticated;

grant insert, update, delete on public.categories, public.products, public.product_variants,
  public.catalog_tabs, public.catalog_placements, public.selection_groups,
  public.modifier_groups, public.modifiers to authenticated;

commit;
