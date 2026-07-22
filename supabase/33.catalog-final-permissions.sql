begin;

revoke all on public.catalog_tab_categories, public.selection_group_options,
  public.product_selection_group_assignments, public.product_selection_group_assignment_variants,
  public.product_modifier_group_assignments, public.product_modifier_group_assignment_variants,
  public.product_images, public.catalog_audit_log from anon;

grant select on public.catalog_tab_categories, public.selection_group_options,
  public.product_selection_group_assignments, public.product_selection_group_assignment_variants,
  public.product_modifier_group_assignments, public.product_modifier_group_assignment_variants,
  public.product_images, public.catalog_audit_log to authenticated;

grant insert, update, delete on public.catalog_tab_categories, public.selection_group_options,
  public.product_selection_group_assignments, public.product_selection_group_assignment_variants,
  public.product_modifier_group_assignments, public.product_modifier_group_assignment_variants,
  public.product_images to authenticated;

commit;
