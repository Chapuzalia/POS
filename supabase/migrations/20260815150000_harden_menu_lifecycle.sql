-- Menu lifecycle, deterministic component snapshots and immediate catalogue invalidation.

alter table public.ticket_lines
  add column if not exists source_order_line_id uuid;

create index if not exists ticket_lines_source_order_line_idx
  on public.ticket_lines (tenant_id, source_order_line_id)
  where source_order_line_id is not null;

comment on column public.ticket_lines.source_order_line_id is
  'Immutable correlation to the restaurant order line used to build this ticket line.';

-- Patch the two restaurant payment RPCs in place. Keeping their complete current
-- definitions avoids forking the payment/discount logic while making the source
-- correlation explicit and transactional.
do $$
declare
  definition text;
  patched text;
begin
  select pg_get_functiondef('public.pay_restaurant_order_items(uuid,integer,jsonb,text,integer,boolean,jsonb)'::regprocedure)
    into definition;
  if position('quantity, source_order_line_id, unit_price_cents, line_total_cents, modifiers' in definition) = 0 then
    if position('quantity, unit_price_cents, line_total_cents, modifiers' in definition) = 0
      or position('ol.product_name, ol.variant_name, selected.quantity, ol.unit_price_cents,' in definition) = 0 then
      raise exception 'MENU_MIGRATION_PAY_ITEMS_SIGNATURE_NOT_FOUND';
    end if;
    patched := replace(
      definition,
      'quantity, unit_price_cents, line_total_cents, modifiers',
      'quantity, source_order_line_id, unit_price_cents, line_total_cents, modifiers'
    );
    patched := replace(
      patched,
      'ol.product_name, ol.variant_name, selected.quantity, ol.unit_price_cents,',
      'ol.product_name, ol.variant_name, selected.quantity, ol.id, ol.unit_price_cents,'
    );
    execute patched;
  end if;

  select pg_get_functiondef('public.pay_restaurant_order_equal_part(uuid,text,integer,boolean,jsonb,boolean)'::regprocedure)
    into definition;
  if position('quantity, allocated_quantity, source_order_line_id, unit_price_cents, line_total_cents, modifiers' in definition) = 0 then
    if position('quantity, allocated_quantity, unit_price_cents, line_total_cents, modifiers' in definition) = 0
      or position('line_row.product_name, line_row.variant_name, 1, allocated_quantity,' in definition) = 0 then
      raise exception 'MENU_MIGRATION_PAY_EQUAL_SIGNATURE_NOT_FOUND';
    end if;
    patched := replace(
      definition,
      'quantity, allocated_quantity, unit_price_cents, line_total_cents, modifiers',
      'quantity, allocated_quantity, source_order_line_id, unit_price_cents, line_total_cents, modifiers'
    );
    patched := replace(
      patched,
      'line_row.product_name, line_row.variant_name, 1, allocated_quantity,',
      'line_row.product_name, line_row.variant_name, 1, allocated_quantity, line_row.id,'
    );
    execute patched;
  end if;
end;
$$;

do $$
declare
  definition text;
  patched text;
  old_served_guard text := $guard$
    if current_line.id is not null and current_line.served_quantity>0 then
      if quantity_value<current_line.served_quantity
        or nullif(item->>'productId','')::uuid is distinct from current_line.product_id
        or nullif(item->>'variantId','')::uuid is distinct from current_line.variant_id then
        raise exception 'CATALOG_SERVED_LINE_IMMUTABLE';
      end if;
      update public.order_lines set quantity=quantity_value,note=note_value,
        fully_served_at=case when quantity_value=served_quantity then coalesce(fully_served_at,now()) else null end
      where id=line_id;
      retained:=array_append(retained,line_id);
      continue;
    end if;$guard$;
  new_served_guard text := $guard$
    if current_line.id is not null and quantity_value<current_line.served_quantity then
      raise exception 'CATALOG_SERVED_QUANTITY_EXCEEDED';
    end if;$guard$;
begin
  select pg_get_functiondef('public.persist_catalog_order_line_draft(uuid,integer,jsonb)'::regprocedure)
    into definition;
  -- Dollar-quoted function bodies preserve the line endings used when they
  -- were created. Production may therefore contain CRLF even though this
  -- migration is checked out with LF, which would make the guarded literal
  -- replacement fail despite the function body being otherwise identical.
  definition := replace(definition, chr(13), '');
  if position('CATALOG_SERVED_QUANTITY_EXCEEDED' in definition) = 0 then
    if position(old_served_guard in definition) = 0 then
      raise exception 'MENU_MIGRATION_SERVED_EDIT_SIGNATURE_NOT_FOUND';
    end if;
    patched := replace(definition, old_served_guard, new_served_guard);
    patched := replace(
      patched,
      'mixer_product_id=null,mixer=null,note=note_value,fully_served_at=null',
      'mixer_product_id=null,mixer=null,note=note_value,fully_served_at=case when served_quantity=quantity_value then coalesce(fully_served_at,now()) else null end'
    );
    execute patched;
  end if;
end;
$$;

create or replace function public.capture_ticket_line_components()
returns trigger
language plpgsql security definer
set search_path = 'public'
as $$
declare
  components_payload jsonb;
begin
  if new.source_order_line_id is not null then
    select ol.components into components_payload
    from public.order_lines ol
    where ol.id = new.source_order_line_id
      and ol.tenant_id = new.tenant_id;
  end if;

  if components_payload is null then
    select line -> 'components' into components_payload
    from public.offline_event_log e
    cross join lateral jsonb_array_elements(e.payload -> 'lines') line
    where e.tenant_id = new.tenant_id
      and e.payload -> 'ticket' ->> 'id' = new.ticket_id::text
      and line ->> 'id' = new.id::text
    order by e.created_at desc
    limit 1;
  end if;

  -- Compatibility fallback for tickets created by an older application version.
  if components_payload is null then
    select (array_agg(ol.components order by ol.updated_at desc))[1]
      into components_payload
    from public.order_lines ol
    join public.orders o on o.id = ol.order_id
    join public.tickets t on t.id = new.ticket_id
    where ol.tenant_id = new.tenant_id
      and o.cash_session_id = t.cash_session_id
      and o.venue_id = t.venue_id
      and ol.product_id is not distinct from new.product_id
      and ol.variant_id is not distinct from new.variant_id
      and ol.product_name = new.product_name
      and ol.variant_name = new.variant_name
      and ol.unit_price_cents = new.unit_price_cents
      and jsonb_array_length(ol.components) > 0
    having count(*) = 1;
  end if;

  if jsonb_typeof(components_payload) = 'array' then
    insert into public.ticket_line_components (
      tenant_id, ticket_line_id, component_type, selection_group_id,
      selection_group_name_snapshot, product_id, variant_id,
      product_name_snapshot, variant_name_snapshot, quantity,
      price_delta_cents, sort_order, metadata
    )
    select new.tenant_id, new.id, c.type,
      nullif(c."selectionGroupId", '')::uuid,
      coalesce(c."selectionGroupName", ''),
      nullif(c."productId", '')::uuid,
      nullif(c."variantId", '')::uuid,
      c."productName", coalesce(c."variantName", ''),
      greatest(c.quantity, 1), c."priceDeltaCents", c."sortOrder",
      coalesce(c.metadata, '{}'::jsonb)
        || jsonb_build_object('modifiers', coalesce(c.modifiers, '[]'::jsonb))
    from jsonb_to_recordset(components_payload) c(
      type text, "selectionGroupId" text, "selectionGroupName" text,
      "productId" text, "variantId" text, "productName" text,
      "variantName" text, quantity integer, "priceDeltaCents" integer,
      "sortOrder" integer, modifiers jsonb, metadata jsonb
    );
  end if;
  return new;
end;
$$;

create or replace function public.force_menu_option_without_default()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.selection_groups g
    where g.id = new.group_id
      and g.venue_id = new.venue_id
      and g.kind = 'menu_component'
  ) then
    new.default_quantity := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists force_menu_option_without_default on public.selection_group_options;
create trigger force_menu_option_without_default
before insert or update of group_id, default_quantity
on public.selection_group_options
for each row execute function public.force_menu_option_without_default();

update public.selection_group_options o
set default_quantity = 0
from public.selection_groups g
where g.id = o.group_id
  and g.kind = 'menu_component'
  and o.default_quantity <> 0;

create or replace function public.guard_menu_component_standard_product()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.selection_groups g
    where g.id = new.group_id
      and g.venue_id = new.venue_id
      and g.kind = 'menu_component'
  ) and not exists (
    select 1
    from public.products p
    where p.id = new.product_id
      and p.venue_id = new.venue_id
      and p.product_type = 'standard'
  ) then
    raise exception 'NESTED_MENU_NOT_ALLOWED';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_menu_component_standard_product on public.selection_group_options;
create trigger guard_menu_component_standard_product
before insert or update of group_id, product_id
on public.selection_group_options
for each row execute function public.guard_menu_component_standard_product();

create or replace function public.menu_is_publishable(p_product_id uuid, p_venue_id uuid)
returns boolean
language sql stable
set search_path = ''
as $$
  with active_variants as (
    select v.id, v.is_default
    from public.product_variants v
    where v.product_id = p_product_id
      and v.venue_id = p_venue_id
      and v.is_active
  ),
  active_assignments as (
    select
      a.id,
      a.group_id,
      a.applies_to_all_variants,
      a.min_selection,
      a.max_selection,
      g.kind,
      coalesce(g.is_active, false) as group_active,
      coalesce((
        select sum(coalesce(o.max_quantity, 1))
        from public.selection_group_options o
        join public.products child on child.id = o.product_id
          and child.venue_id = o.venue_id
          and child.product_type = 'standard'
          and child.is_active
        where o.group_id = a.group_id
          and o.venue_id = a.venue_id
          and o.is_active
          and (
            (o.variant_id is null and exists (
              select 1
              from public.product_variants child_variant
              where child_variant.product_id = child.id
                and child_variant.venue_id = child.venue_id
                and child_variant.is_active
                and child_variant.is_default
            ))
            or (o.variant_id is not null and exists (
              select 1
              from public.product_variants child_variant
              where child_variant.id = o.variant_id
                and child_variant.product_id = child.id
                and child_variant.venue_id = child.venue_id
                and child_variant.is_active
            ))
          )
      ), 0) as capacity
    from public.product_selection_group_assignments a
    left join public.selection_groups g on g.id = a.group_id
      and g.venue_id = a.venue_id
    where a.product_id = p_product_id
      and a.venue_id = p_venue_id
      and a.is_active
  ),
  valid_assignments as (
    select a.*
    from active_assignments a
    where a.kind = 'menu_component'
      and a.group_active
      and a.min_selection >= 1
      and a.max_selection >= a.min_selection
      and a.capacity >= a.min_selection
      and (
        a.applies_to_all_variants
        or exists (
          select 1
          from public.product_selection_group_assignment_variants scope
          join active_variants v on v.id = scope.variant_id
          where scope.assignment_id = a.id
        )
      )
  )
  select exists (
    select 1
    from public.products p
    where p.id = p_product_id
      and p.venue_id = p_venue_id
      and p.product_type = 'menu'
  )
  and (select count(*) from active_variants) > 0
  and (select count(*) from active_variants where is_default) = 1
  and exists (select 1 from valid_assignments)
  and not exists (
    select 1
    from active_assignments active_assignment
    left join valid_assignments valid_assignment on valid_assignment.id = active_assignment.id
    where valid_assignment.id is null
  )
  and not exists (
    select 1
    from active_variants variant
    where not exists (
      select 1
      from valid_assignments assignment
      where assignment.applies_to_all_variants
        or exists (
          select 1
          from public.product_selection_group_assignment_variants scope
          where scope.assignment_id = assignment.id
            and scope.variant_id = variant.id
        )
    )
  );
$$;

-- Destructive cutover: menu courses belong to the menu editor. Remove legacy
-- crossings first, then discard menus that cannot be represented safely by the
-- new format. Historical sale lines keep their immutable snapshots.
delete from public.product_selection_group_assignments assignment
using public.products product, public.selection_groups selection_group
where assignment.product_id = product.id
  and assignment.venue_id = product.venue_id
  and assignment.group_id = selection_group.id
  and assignment.venue_id = selection_group.venue_id
  and selection_group.kind = 'menu_component'
  and product.product_type <> 'menu';

delete from public.product_selection_group_assignments assignment
using public.products product
where assignment.product_id = product.id
  and assignment.venue_id = product.venue_id
  and product.product_type = 'menu'
  and not assignment.is_active;

delete from public.selection_group_options option
using public.selection_groups selection_group, public.products child
where option.group_id = selection_group.id
  and option.venue_id = selection_group.venue_id
  and option.product_id = child.id
  and option.venue_id = child.venue_id
  and selection_group.kind = 'menu_component'
  and (
    child.product_type <> 'standard'
    or not child.is_active
    or not (
      (option.variant_id is null and exists (
        select 1
        from public.product_variants child_variant
        where child_variant.product_id = child.id
          and child_variant.venue_id = child.venue_id
          and child_variant.is_active
          and child_variant.is_default
      ))
      or (option.variant_id is not null and exists (
        select 1
        from public.product_variants child_variant
        where child_variant.id = option.variant_id
          and child_variant.product_id = child.id
          and child_variant.venue_id = child.venue_id
          and child_variant.is_active
      ))
    )
  );

delete from public.products product
where product.product_type = 'menu'
  and not public.menu_is_publishable(product.id, product.venue_id);

delete from public.selection_groups selection_group
where selection_group.kind = 'menu_component'
  and not exists (
    select 1
    from public.product_selection_group_assignments assignment
    where assignment.group_id = selection_group.id
      and assignment.venue_id = selection_group.venue_id
  );

create or replace function public.guard_selection_group_assignment_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  product_kind text;
  group_kind text;
begin
  select p.product_type into product_kind
  from public.products p
  where p.id = new.product_id and p.venue_id = new.venue_id;

  select g.kind into group_kind
  from public.selection_groups g
  where g.id = new.group_id and g.venue_id = new.venue_id;

  if product_kind is not null
    and group_kind is not null
    and ((product_kind = 'menu') is distinct from (group_kind = 'menu_component')) then
    raise exception 'CATALOG_SELECTION_GROUP_SCOPE_INVALID';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_selection_group_assignment_scope on public.product_selection_group_assignments;
create trigger guard_selection_group_assignment_scope
before insert or update of product_id, group_id
on public.product_selection_group_assignments
for each row execute function public.guard_selection_group_assignment_scope();

create or replace function public.guard_selection_group_kind_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind and exists (
    select 1
    from public.product_selection_group_assignments assignment
    join public.products product on product.id = assignment.product_id
      and product.venue_id = assignment.venue_id
    where assignment.group_id = new.id
      and assignment.venue_id = new.venue_id
      and ((product.product_type = 'menu') is distinct from (new.kind = 'menu_component'))
  ) then
    raise exception 'CATALOG_SELECTION_GROUP_SCOPE_INVALID';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_selection_group_kind_scope on public.selection_groups;
create trigger guard_selection_group_kind_scope
before update of kind on public.selection_groups
for each row execute function public.guard_selection_group_kind_scope();

create or replace function public.guard_product_type_selection_scope()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.product_type is distinct from old.product_type and exists (
    select 1
    from public.product_selection_group_assignments assignment
    join public.selection_groups selection_group on selection_group.id = assignment.group_id
      and selection_group.venue_id = assignment.venue_id
    where assignment.product_id = new.id
      and assignment.venue_id = new.venue_id
      and ((new.product_type = 'menu') is distinct from (selection_group.kind = 'menu_component'))
  ) then
    raise exception 'CATALOG_SELECTION_GROUP_SCOPE_INVALID';
  end if;

  if new.product_type = 'menu' and exists (
    select 1
    from public.selection_group_options option
    join public.selection_groups selection_group on selection_group.id = option.group_id
      and selection_group.venue_id = option.venue_id
    where option.product_id = new.id
      and option.venue_id = new.venue_id
      and selection_group.kind = 'menu_component'
  ) then
    raise exception 'NESTED_MENU_NOT_ALLOWED';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_product_type_selection_scope on public.products;
create trigger guard_product_type_selection_scope
before update of product_type on public.products
for each row execute function public.guard_product_type_selection_scope();

create or replace function public.guard_menu_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.product_type = 'menu'
    and new.is_active
    and (tg_op = 'INSERT' or old.is_active is distinct from true)
    and not public.menu_is_publishable(new.id, new.venue_id) then
    raise exception 'CATALOG_MENU_INCOMPLETE';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_menu_publication on public.products;
create trigger guard_menu_publication
before insert or update of is_active, product_type
on public.products
for each row execute function public.guard_menu_publication();

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

drop trigger if exists guard_published_menu_assignment on public.product_selection_group_assignments;
create constraint trigger guard_published_menu_assignment
after insert or update or delete on public.product_selection_group_assignments
deferrable initially deferred for each row execute function public.guard_published_menu_dependencies();

drop trigger if exists guard_published_menu_option on public.selection_group_options;
create constraint trigger guard_published_menu_option
after insert or update or delete on public.selection_group_options
deferrable initially deferred for each row execute function public.guard_published_menu_dependencies();

drop trigger if exists guard_published_menu_group on public.selection_groups;
create constraint trigger guard_published_menu_group
after insert or update or delete on public.selection_groups
deferrable initially deferred for each row execute function public.guard_published_menu_dependencies();

drop trigger if exists guard_published_menu_variant on public.product_variants;
create constraint trigger guard_published_menu_variant
after insert or update or delete on public.product_variants
deferrable initially deferred for each row execute function public.guard_published_menu_dependencies();

drop trigger if exists guard_published_menu_assignment_variant on public.product_selection_group_assignment_variants;
create constraint trigger guard_published_menu_assignment_variant
after insert or update or delete on public.product_selection_group_assignment_variants
deferrable initially deferred for each row execute function public.guard_published_menu_dependencies();

drop trigger if exists guard_published_menu_product on public.products;
create constraint trigger guard_published_menu_product
after update or delete on public.products
deferrable initially deferred for each row execute function public.guard_published_menu_dependencies();

create or replace function public.set_catalog_product_published(
  p_venue_id uuid,
  p_product_id uuid,
  p_active boolean
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
begin
  select v.tenant_id into v_tenant_id
  from public.venues v
  where v.id = p_venue_id;
  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN' using errcode = '42501';
  end if;
  if p_active and exists (
    select 1 from public.products p
    where p.id = p_product_id
      and p.venue_id = p_venue_id
      and p.product_type = 'menu'
  ) and not public.menu_is_publishable(p_product_id, p_venue_id) then
    raise exception 'CATALOG_MENU_INCOMPLETE';
  end if;
  update public.products
  set is_active = p_active
  where id = p_product_id and venue_id = p_venue_id;
  if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;
  update public.catalog_placements
  set is_active = p_active
  where product_id = p_product_id and venue_id = p_venue_id;
end;
$$;

revoke all on function public.set_catalog_product_published(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_catalog_product_published(uuid, uuid, boolean) to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'categories', 'catalog_tab_categories', 'products', 'product_variants',
    'catalog_placements', 'selection_groups', 'selection_group_options',
    'product_selection_group_assignments', 'product_selection_group_assignment_variants',
    'modifier_groups', 'modifiers', 'product_modifier_group_assignments',
    'product_modifier_group_assignment_variants'
  ] loop
    if to_regclass(format('public.%I', table_name)) is not null and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;
