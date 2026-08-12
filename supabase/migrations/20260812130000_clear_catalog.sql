-- Transactional full-catalog deletion for a single venue.
-- Historical sales, tickets, fiscal records, inventory movements and venue configuration
-- are deliberately outside this function.

create or replace function public.clear_catalog(p_venue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_counts jsonb;
  v_candidate_paths text[] := '{}';
  v_removed_paths text[] := '{}';
begin
  select v.tenant_id into v_tenant_id
  from public.venues v
  where v.id = p_venue_id
  for update;

  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role'
    and not public.user_is_tenant_admin(v_tenant_id)
  then
    raise exception 'CATALOG_CLEAR_FORBIDDEN';
  end if;

  select jsonb_build_object(
    'products', (select count(*) from public.products where venue_id = p_venue_id),
    'variants', (select count(*) from public.product_variants where venue_id = p_venue_id),
    'formats', (select count(*) from public.catalog_sale_formats where venue_id = p_venue_id),
    'tabs', (select count(*) from public.catalog_tabs where venue_id = p_venue_id),
    'categories', (select count(*) from public.categories where venue_id = p_venue_id),
    'tabCategories', (select count(*) from public.catalog_tab_categories where venue_id = p_venue_id),
    'placements', (select count(*) from public.catalog_placements where venue_id = p_venue_id),
    'selectionGroups', (select count(*) from public.selection_groups where venue_id = p_venue_id),
    'selectionOptions', (select count(*) from public.selection_group_options where venue_id = p_venue_id),
    'selectionAssignments', (select count(*) from public.product_selection_group_assignments where venue_id = p_venue_id),
    'modifierGroups', (select count(*) from public.modifier_groups where venue_id = p_venue_id),
    'modifiers', (select count(*) from public.modifiers where venue_id = p_venue_id),
    'modifierAssignments', (select count(*) from public.product_modifier_group_assignments where venue_id = p_venue_id),
    'images', (select count(*) from public.product_images where venue_id = p_venue_id)
  ) into v_counts;

  select coalesce(array_agg(distinct i.storage_path), '{}')
  into v_candidate_paths
  from public.product_images i
  where i.venue_id = p_venue_id;

  -- These root deletes rely on the catalogue's venue-scoped cascade constraints.
  -- The order mirrors import_catalog's proven replacement path.
  delete from public.products where venue_id = p_venue_id;
  delete from public.catalog_sale_formats where venue_id = p_venue_id;
  delete from public.catalog_tabs where venue_id = p_venue_id;
  delete from public.selection_groups where venue_id = p_venue_id;
  delete from public.modifier_groups where venue_id = p_venue_id;
  delete from public.categories where venue_id = p_venue_id;

  set constraints all immediate;

  -- Only remove a storage object when no remaining image row still references it.
  select coalesce(array_agg(candidate.path), '{}')
  into v_removed_paths
  from unnest(v_candidate_paths) as candidate(path)
  where not exists (
    select 1
    from public.product_images remaining
    where remaining.storage_path = candidate.path
  );

  return jsonb_build_object(
    'result', 'SUCCESS',
    'counts', v_counts,
    'removedImagePaths', to_jsonb(v_removed_paths)
  );
end;
$$;

comment on function public.clear_catalog(uuid) is
  'Atomically deletes the complete live catalog for one venue while preserving historical and venue data.';

revoke all on function public.clear_catalog(uuid) from public, anon;
grant execute on function public.clear_catalog(uuid) to authenticated, service_role;

