-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserves existing routine signatures and access while making new sale-line snapshots use the same inventory resolution semantics as stock consumption.
set lock_timeout = '5s';
set statement_timeout = '5min';

create function public.theoretical_ticket_line_cost(
  p_ticket_line_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_line public.ticket_lines%rowtype;
  v_venue_id uuid;
  v_sold_quantity numeric(18, 9);
  v_component record;
  v_modifier jsonb;
  v_modifier_row record;
  v_mixer_product_id uuid;
  v_mixer_variant_id uuid;
  v_resolved record;
  v_item_cost jsonb;
  v_cost numeric := 0;
  v_known boolean := false;
begin
  select line.*
  into v_line
  from public.ticket_lines line
  where line.id = p_ticket_line_id;

  if v_line.id is null then
    return jsonb_build_object('known', false, 'cost', 0);
  end if;

  select ticket.venue_id
  into v_venue_id
  from public.tickets ticket
  where ticket.id = v_line.ticket_id
    and ticket.tenant_id = v_line.tenant_id;

  if v_venue_id is null then
    return jsonb_build_object('known', false, 'cost', 0);
  end if;

  create temporary table if not exists pg_temp.inventory_resolved_line (
    inventory_item_id uuid primary key,
    stock_quantity numeric(18, 6) not null,
    sources jsonb not null
  ) on commit drop;

  create temporary table if not exists pg_temp.inventory_selected_modifier (
    modifier_id uuid not null,
    multiplier numeric(18, 9) not null
  ) on commit drop;

  truncate pg_temp.inventory_resolved_line;
  truncate pg_temp.inventory_selected_modifier;

  v_sold_quantity := coalesce(
    v_line.allocated_quantity,
    v_line.quantity::numeric
  );

  -- Keep this resolution in lockstep with consume_ticket_line_inventory():
  -- base product, captured components, legacy mixer, then REMOVE before ADD.
  perform public.inventory_accumulate_variant_recipe(
    v_line.tenant_id,
    v_venue_id,
    v_line.variant_id,
    v_sold_quantity,
    'product',
    v_line.product_id
  );

  for v_component in
    select
      component.component_type,
      component.product_id,
      component.variant_id,
      component.quantity,
      component.metadata
    from public.ticket_line_components component
    where component.ticket_line_id = v_line.id
      and component.tenant_id = v_line.tenant_id
      and component.product_id is not null
    order by component.sort_order, component.id
  loop
    if v_component.variant_id is null then
      select variant.id
      into v_component.variant_id
      from public.product_variants variant
      where variant.product_id = v_component.product_id
        and variant.tenant_id = v_line.tenant_id
        and variant.venue_id = v_venue_id
        and variant.is_active
      order by variant.is_default desc, variant.sort_order, variant.id
      limit 1;
    end if;

    perform public.inventory_accumulate_variant_recipe(
      v_line.tenant_id,
      v_venue_id,
      v_component.variant_id,
      v_sold_quantity * v_component.quantity,
      case
        when v_component.component_type = 'mixer' then 'mixer'
        else 'menu_component'
      end,
      v_component.product_id
    );

    for v_modifier in
      select value
      from jsonb_array_elements(
        coalesce(
          v_component.metadata -> 'modifiers',
          '[]'::jsonb
        )
      )
    loop
      if v_modifier ->> 'id'
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then
        insert into pg_temp.inventory_selected_modifier (
          modifier_id,
          multiplier
        ) values (
          (v_modifier ->> 'id')::uuid,
          v_sold_quantity * v_component.quantity
        );
      end if;
    end loop;
  end loop;

  for v_modifier in
    select value
    from jsonb_array_elements(
      coalesce(v_line.modifiers, '[]'::jsonb)
    )
  loop
    if v_modifier ->> 'id'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      insert into pg_temp.inventory_selected_modifier (
        modifier_id,
        multiplier
      ) values (
        (v_modifier ->> 'id')::uuid,
        v_sold_quantity
      );
    elsif v_modifier ->> 'id'
      ~* '^mixer:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and not exists (
        select 1
        from public.ticket_line_components component
        where component.ticket_line_id = v_line.id
          and component.tenant_id = v_line.tenant_id
          and component.component_type = 'mixer'
      )
    then
      v_mixer_product_id := substring(
        v_modifier ->> 'id' from 7
      )::uuid;

      select variant.id
      into v_mixer_variant_id
      from public.product_variants variant
      where variant.product_id = v_mixer_product_id
        and variant.tenant_id = v_line.tenant_id
        and variant.venue_id = v_venue_id
        and variant.is_active
      order by variant.is_default desc, variant.sort_order, variant.id
      limit 1;

      perform public.inventory_accumulate_variant_recipe(
        v_line.tenant_id,
        v_venue_id,
        v_mixer_variant_id,
        v_sold_quantity,
        'mixer',
        v_mixer_product_id
      );
    end if;
  end loop;

  -- Stable modifier semantics: every REMOVE precedes every ADD.
  delete from pg_temp.inventory_resolved_line resolved
  using public.modifier_inventory_effects effect
  where effect.operation = 'REMOVE'
    and effect.inventory_item_id = resolved.inventory_item_id
    and effect.tenant_id = v_line.tenant_id
    and effect.venue_id = v_venue_id
    and effect.modifier_id in (
      select selected.modifier_id
      from pg_temp.inventory_selected_modifier selected
    );

  for v_modifier_row in
    select
      effect.*,
      selected.multiplier,
      item.base_unit_id
    from pg_temp.inventory_selected_modifier selected
    join public.modifier_inventory_effects effect
      on effect.modifier_id = selected.modifier_id
     and effect.tenant_id = v_line.tenant_id
     and effect.venue_id = v_venue_id
     and effect.operation = 'ADD'
    join public.inventory_items item
      on item.id = effect.inventory_item_id
     and item.tenant_id = effect.tenant_id
     and item.venue_id = effect.venue_id
    order by effect.sort_order, effect.id
  loop
    insert into pg_temp.inventory_resolved_line (
      inventory_item_id,
      stock_quantity,
      sources
    ) values (
      v_modifier_row.inventory_item_id,
      public.inventory_convert_quantity(
        v_line.tenant_id,
        v_venue_id,
        v_modifier_row.quantity * v_modifier_row.multiplier,
        v_modifier_row.unit_id,
        v_modifier_row.base_unit_id
      ),
      jsonb_build_array(
        jsonb_build_object(
          'type', 'modifier',
          'sourceId', v_modifier_row.modifier_id,
          'recipeQuantity', v_modifier_row.quantity,
          'recipeUnitId', v_modifier_row.unit_id,
          'multiplier', v_modifier_row.multiplier
        )
      )
    )
    on conflict (inventory_item_id) do update
    set stock_quantity =
          pg_temp.inventory_resolved_line.stock_quantity
          + excluded.stock_quantity,
        sources =
          pg_temp.inventory_resolved_line.sources
          || excluded.sources;
  end loop;

  for v_resolved in
    select
      resolved.inventory_item_id,
      resolved.stock_quantity,
      item.base_unit_id
    from pg_temp.inventory_resolved_line resolved
    join public.inventory_items item
      on item.id = resolved.inventory_item_id
     and item.tenant_id = v_line.tenant_id
     and item.venue_id = v_venue_id
  loop
    v_item_cost := public.theoretical_inventory_item_cost(
      v_line.tenant_id,
      v_venue_id,
      v_resolved.inventory_item_id,
      v_resolved.stock_quantity,
      v_resolved.base_unit_id
    );

    v_cost :=
      v_cost
      + coalesce((v_item_cost ->> 'cost')::numeric, 0);
    v_known :=
      v_known
      or coalesce((v_item_cost ->> 'known')::boolean, false);
  end loop;

  return jsonb_build_object(
    'known', v_known,
    'cost', round(v_cost, 6)
  );
end;
$$;

create or replace function public.set_ticket_line_theoretical_cost()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_venue_id uuid;
  v_multiplier numeric;
  v_cost jsonb;
begin
  -- AFTER INSERT persists the complete snapshot once captured components exist.
  -- Only that nested update may write it; later updates retain the historical value.
  if tg_op = 'UPDATE' then
    if pg_trigger_depth() > 1 then
      return new;
    end if;

    new.theoretical_cost_known := old.theoretical_cost_known;
    new.theoretical_cost_cents := old.theoretical_cost_cents;
    return new;
  end if;

  select ticket.venue_id
  into v_venue_id
  from public.tickets ticket
  where ticket.id = new.ticket_id
    and ticket.tenant_id = new.tenant_id;

  v_multiplier := coalesce(
    new.allocated_quantity,
    new.quantity::numeric
  );

  v_cost := public.theoretical_variant_cost(
    new.tenant_id,
    v_venue_id,
    new.variant_id,
    v_multiplier
  );

  new.theoretical_cost_known := coalesce(
    (v_cost ->> 'known')::boolean,
    false
  );

  new.theoretical_cost_cents :=
    case
      when new.theoretical_cost_known
      then round(
        coalesce((v_cost ->> 'cost')::numeric, 0) * 100
      )::integer
      else null
    end;

  return new;
end;
$$;

create function public.snapshot_ticket_line_theoretical_cost()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_cost jsonb;
  v_known boolean;
begin
  v_cost := public.theoretical_ticket_line_cost(new.id);
  v_known := coalesce((v_cost ->> 'known')::boolean, false);

  update public.ticket_lines line
  set theoretical_cost_known = v_known,
      theoretical_cost_cents =
        case
          when v_known
          then round(
            coalesce((v_cost ->> 'cost')::numeric, 0) * 100
          )::integer
          else null
        end
  where line.id = new.id
    and line.tenant_id = new.tenant_id;

  return new;
end;
$$;

-- PostgreSQL executes same-kind triggers by name. This zz-prefixed trigger runs
-- after capture_ticket_line_components and consume_ticket_line_inventory.
create trigger zz_set_ticket_line_theoretical_cost_after_components
after insert on public.ticket_lines
for each row
execute function public.snapshot_ticket_line_theoretical_cost();

revoke all on function
  public.theoretical_ticket_line_cost(uuid),
  public.snapshot_ticket_line_theoretical_cost()
from public, anon, authenticated;

comment on function public.theoretical_ticket_line_cost(uuid) is
  'Resolves the complete inventory consumption of a persisted ticket line and calculates its theoretical cost.';

comment on column public.ticket_lines.theoretical_cost_cents is
  'Immutable theoretical cost snapshot in cents for all inventory consumed by the sale line; null means no cost data existed.';
