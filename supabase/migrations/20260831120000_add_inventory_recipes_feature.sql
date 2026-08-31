-- Escandallos are an optional tenant capability. Deliberately do not backfill
-- tenant_feature_assignments: existing and newly-created tenants stay disabled
-- until a superadmin explicitly enables the feature.

insert into public.platform_features (
  key, name, description, is_core, is_active, enabled_by_default, sort_order
)
values (
  'inventory_recipes', 'Escandallos',
  'Escandallos de producto, efectos de modificadores y elaboraciones de inventario.',
  false, true, false, 160
)
on conflict (key) do update
set name = excluded.name,
    description = excluded.description,
    is_core = excluded.is_core,
    is_active = excluded.is_active,
    enabled_by_default = excluded.enabled_by_default,
    sort_order = excluded.sort_order,
    updated_at = now();

create or replace function public.inventory_recipes_feature_enabled(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from public.tenant_feature_assignments assignment
    join public.platform_features feature
      on feature.key = assignment.feature_key
     and feature.is_active = true
    where assignment.tenant_id = p_tenant_id
      and assignment.feature_key = 'inventory_recipes'
  );
$$;

-- Keep direct, single-item inventory consumption available under the existing
-- Inventory feature, while composite recipes require Escandallos.
alter function public.inventory_accumulate_variant_recipe(uuid, uuid, uuid, numeric, text, uuid)
  rename to inventory_accumulate_variant_recipe_without_feature_check;

create or replace function public.inventory_accumulate_variant_recipe(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_variant_id uuid,
  p_multiplier numeric,
  p_source_type text,
  p_source_id uuid
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_mode text;
begin
  select recipe.mode into v_mode
  from public.inventory_recipes recipe
  where recipe.tenant_id = p_tenant_id
    and recipe.venue_id = p_venue_id
    and recipe.variant_id = p_variant_id
    and recipe.is_active;

  if v_mode = 'recipe' and not public.inventory_recipes_feature_enabled(p_tenant_id) then
    return;
  end if;

  perform public.inventory_accumulate_variant_recipe_without_feature_check(
    p_tenant_id, p_venue_id, p_variant_id, p_multiplier, p_source_type, p_source_id
  );
end;
$$;

alter function public.save_variant_inventory_recipe(uuid, text, jsonb)
  rename to save_variant_inventory_recipe_without_feature_check;

create or replace function public.save_variant_inventory_recipe(
  p_variant_id uuid,
  p_mode text,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
begin
  select variant.tenant_id into v_tenant_id
  from public.product_variants variant
  where variant.id = p_variant_id;

  if p_mode = 'recipe'
    and v_tenant_id is not null
    and not public.inventory_recipes_feature_enabled(v_tenant_id)
  then
    raise exception 'INVENTORY_RECIPES_FEATURE_DISABLED' using errcode = '42501';
  end if;

  return public.save_variant_inventory_recipe_without_feature_check(p_variant_id, p_mode, p_lines);
end;
$$;

alter function public.save_modifier_inventory_effects(uuid, jsonb)
  rename to save_modifier_inventory_effects_without_feature_check;

create or replace function public.save_modifier_inventory_effects(
  p_modifier_id uuid,
  p_effects jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
begin
  select modifier.tenant_id into v_tenant_id
  from public.modifiers modifier
  where modifier.id = p_modifier_id;

  if v_tenant_id is not null
    and not public.inventory_recipes_feature_enabled(v_tenant_id)
  then
    raise exception 'INVENTORY_RECIPES_FEATURE_DISABLED' using errcode = '42501';
  end if;

  perform public.save_modifier_inventory_effects_without_feature_check(p_modifier_id, p_effects);
end;
$$;

alter function public.save_inventory_production_recipe(uuid, uuid, numeric, uuid, boolean, jsonb)
  rename to save_inventory_production_recipe_without_feature_check;

create or replace function public.save_inventory_production_recipe(
  p_inventory_item_id uuid,
  p_production_warehouse_id uuid,
  p_reference_quantity numeric,
  p_reference_unit_id uuid,
  p_active boolean,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
begin
  select item.tenant_id into v_tenant_id
  from public.inventory_items item
  where item.id = p_inventory_item_id;

  if v_tenant_id is not null
    and not public.inventory_recipes_feature_enabled(v_tenant_id)
  then
    raise exception 'INVENTORY_RECIPES_FEATURE_DISABLED' using errcode = '42501';
  end if;

  return public.save_inventory_production_recipe_without_feature_check(
    p_inventory_item_id,
    p_production_warehouse_id,
    p_reference_quantity,
    p_reference_unit_id,
    p_active,
    p_lines
  );
end;
$$;

alter function public.preview_inventory_production(uuid, numeric, uuid)
  rename to preview_inventory_production_without_feature_check;

create or replace function public.preview_inventory_production(
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_unit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
begin
  select item.tenant_id into v_tenant_id
  from public.inventory_items item
  where item.id = p_inventory_item_id;

  if v_tenant_id is not null
    and not public.inventory_recipes_feature_enabled(v_tenant_id)
  then
    raise exception 'INVENTORY_RECIPES_FEATURE_DISABLED' using errcode = '42501';
  end if;

  return public.preview_inventory_production_without_feature_check(
    p_inventory_item_id, p_quantity, p_unit_id
  );
end;
$$;

alter function public.list_inventory_preparations(uuid)
  rename to list_inventory_preparations_without_feature_check;

create or replace function public.list_inventory_preparations(p_venue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
begin
  select venue.tenant_id into v_tenant_id
  from public.venues venue
  where venue.id = p_venue_id;

  if v_tenant_id is not null
    and not public.inventory_recipes_feature_enabled(v_tenant_id)
  then
    return '[]'::jsonb;
  end if;

  return public.list_inventory_preparations_without_feature_check(p_venue_id);
end;
$$;

alter function public.record_inventory_production(uuid, numeric, uuid, uuid, uuid)
  rename to record_inventory_production_without_feature_check;

create or replace function public.record_inventory_production(
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_unit_id uuid,
  p_device_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
begin
  select item.tenant_id into v_tenant_id
  from public.inventory_items item
  where item.id = p_inventory_item_id;

  if v_tenant_id is not null
    and not public.inventory_recipes_feature_enabled(v_tenant_id)
  then
    raise exception 'INVENTORY_RECIPES_FEATURE_DISABLED' using errcode = '42501';
  end if;

  return public.record_inventory_production_without_feature_check(
    p_inventory_item_id, p_quantity, p_unit_id, p_device_id, p_request_id
  );
end;
$$;

revoke all on function public.inventory_recipes_feature_enabled(uuid),
  public.inventory_accumulate_variant_recipe_without_feature_check(uuid, uuid, uuid, numeric, text, uuid),
  public.save_variant_inventory_recipe_without_feature_check(uuid, text, jsonb),
  public.save_modifier_inventory_effects_without_feature_check(uuid, jsonb),
  public.save_inventory_production_recipe_without_feature_check(uuid, uuid, numeric, uuid, boolean, jsonb),
  public.preview_inventory_production_without_feature_check(uuid, numeric, uuid),
  public.list_inventory_preparations_without_feature_check(uuid),
  public.record_inventory_production_without_feature_check(uuid, numeric, uuid, uuid, uuid),
  public.inventory_accumulate_variant_recipe(uuid, uuid, uuid, numeric, text, uuid)
from public, anon, authenticated;

revoke all on function public.save_variant_inventory_recipe(uuid, text, jsonb),
  public.save_modifier_inventory_effects(uuid, jsonb),
  public.save_inventory_production_recipe(uuid, uuid, numeric, uuid, boolean, jsonb),
  public.preview_inventory_production(uuid, numeric, uuid),
  public.list_inventory_preparations(uuid),
  public.record_inventory_production(uuid, numeric, uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function public.save_variant_inventory_recipe(uuid, text, jsonb),
  public.save_modifier_inventory_effects(uuid, jsonb),
  public.save_inventory_production_recipe(uuid, uuid, numeric, uuid, boolean, jsonb),
  public.preview_inventory_production(uuid, numeric, uuid),
  public.list_inventory_preparations(uuid),
  public.record_inventory_production(uuid, numeric, uuid, uuid, uuid)
to authenticated;

comment on function public.inventory_recipes_feature_enabled(uuid) is
  'True when the tenant has the active Escandallos feature assignment.';
