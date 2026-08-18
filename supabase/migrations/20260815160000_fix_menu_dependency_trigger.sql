-- Hotfix for databases where 20260815150000_harden_menu_lifecycle.sql was
-- already applied. Use JSONB trigger rows so the shared function never reads a
-- column that does not exist on the table that fired it.
create or replace function public.guard_published_menu_dependencies()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  old_row jsonb := '{}'::jsonb;
  new_row jsonb := '{}'::jsonb;
  child_product_ids uuid[] := array[]::uuid[];
  candidate_product_ids uuid[] := array[]::uuid[];
  product_id_value uuid;
begin
  if tg_op <> 'INSERT' then old_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then new_row := to_jsonb(new); end if;

  if tg_table_name in ('products', 'product_variants') then
    if tg_table_name = 'products' then
      child_product_ids := array[
        nullif(old_row ->> 'id', '')::uuid,
        nullif(new_row ->> 'id', '')::uuid
      ];
    else
      child_product_ids := array[
        nullif(old_row ->> 'product_id', '')::uuid,
        nullif(new_row ->> 'product_id', '')::uuid
      ];
    end if;

    candidate_product_ids := coalesce((
      select array_agg(distinct candidate.product_id)
      from (
        select child_id as product_id
        from unnest(child_product_ids) child_id
        where child_id is not null
        union
        select assignment.product_id
        from public.selection_group_options option
        join public.product_selection_group_assignments assignment
          on assignment.group_id = option.group_id and assignment.is_active
        where option.product_id = any(child_product_ids)
      ) candidate
    ), array[]::uuid[]);
  elsif tg_table_name = 'product_selection_group_assignments' then
    candidate_product_ids := array[
      nullif(old_row ->> 'product_id', '')::uuid,
      nullif(new_row ->> 'product_id', '')::uuid
    ];
  elsif tg_table_name = 'product_selection_group_assignment_variants' then
    candidate_product_ids := coalesce((
      select array_agg(distinct assignment.product_id)
      from public.product_selection_group_assignments assignment
      where assignment.id = any(array[
        nullif(old_row ->> 'assignment_id', '')::uuid,
        nullif(new_row ->> 'assignment_id', '')::uuid
      ])
    ), array[]::uuid[]);
  else
    candidate_product_ids := coalesce((
      select array_agg(distinct assignment.product_id)
      from public.product_selection_group_assignments assignment
      where assignment.group_id = any(array[
        case when tg_table_name = 'selection_groups' then nullif(old_row ->> 'id', '')::uuid else nullif(old_row ->> 'group_id', '')::uuid end,
        case when tg_table_name = 'selection_groups' then nullif(new_row ->> 'id', '')::uuid else nullif(new_row ->> 'group_id', '')::uuid end
      ])
    ), array[]::uuid[]);
  end if;

  for product_id_value in
    select distinct candidate_id
    from unnest(candidate_product_ids) candidate_id
    where candidate_id is not null
  loop
    if exists (
      select 1
      from public.products product
      where product.id = product_id_value
        and product.is_active
        and product.product_type = 'menu'
        and not public.menu_is_publishable(product.id, product.venue_id)
    ) then
      raise exception 'CATALOG_MENU_INCOMPLETE';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
