-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserves the trigger signature and all existing checks while allowing only inactive menu drafts to retain active assignments before guarded publication.
create or replace function public.validate_catalog_entity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  product_is_active boolean;
  product_type text;
begin
  if not exists (
    select 1
    from public.venues v
    where v.id = new.venue_id
      and v.tenant_id = new.tenant_id
  ) then
    raise exception 'CATALOG_SCOPE_MISMATCH';
  end if;

  if tg_table_name = 'selection_group_options' then
    if (
      select p.product_type
      from public.products p
      where p.id = new.product_id
        and p.venue_id = new.venue_id
    ) <> 'standard' then
      raise exception 'NESTED_MENU_NOT_ALLOWED';
    end if;
  elsif tg_table_name in ('product_selection_group_assignments', 'product_modifier_group_assignments') then
    select p.is_active, p.product_type
    into product_is_active, product_type
    from public.products p
    where p.id = new.product_id
      and p.venue_id = new.venue_id;

    if new.is_active
      and not coalesce(product_is_active, false)
      and product_type <> 'menu' then
      raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_PRODUCT';
    end if;

    if new.is_active
      and tg_table_name = 'product_selection_group_assignments'
      and not (
        select g.is_active
        from public.selection_groups g
        where g.id = new.group_id
          and g.venue_id = new.venue_id
      ) then
      raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_GROUP';
    end if;

    if new.is_active
      and tg_table_name = 'product_modifier_group_assignments'
      and not (
        select g.is_active
        from public.modifier_groups g
        where g.id = new.group_id
          and g.venue_id = new.venue_id
      ) then
      raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_GROUP';
    end if;
  end if;

  return new;
end;
$$;
