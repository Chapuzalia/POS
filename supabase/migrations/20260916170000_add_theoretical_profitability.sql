-- migration-safety: expand
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Adds theoretical profitability snapshots and reporting RPCs. Internal SECURITY DEFINER helpers remain inaccessible to client roles; only CRM reporting RPCs are executable by authenticated users.
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.ticket_lines
  add column if not exists theoretical_cost_cents integer,
  add column if not exists theoretical_cost_known boolean not null default false;

alter table public.ticket_lines
  add constraint ticket_lines_theoretical_cost_check check (
    (
      theoretical_cost_known is true
      and (theoretical_cost_cents >= 0) is true
    )
    or (
      theoretical_cost_known is false
      and theoretical_cost_cents is null
    )
  ) not valid;

create index if not exists ticket_lines_profitability_ticket_idx
  on public.ticket_lines (tenant_id, ticket_id)
  include (
    product_id,
    category_id_snapshot,
    quantity,
    allocated_quantity,
    line_total_cents,
    net_total_cents,
    taxable_base_cents,
    theoretical_cost_cents,
    theoretical_cost_known
  );

create index if not exists supplier_document_lines_profitability_cost_idx
  on public.supplier_document_lines (
    tenant_id,
    venue_id,
    inventory_item_id,
    supplier_document_id
  )
  where normalized_unit_cost is not null
    and inventory_item_id is not null;

create function public.theoretical_inventory_item_unit_cost(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_inventory_item_id uuid
)
returns numeric
language sql
stable
security definer
set search_path to ''
as $$
  select avg(costs.normalized_unit_cost)
  from (
    select line.normalized_unit_cost
    from public.supplier_document_lines line
    join public.supplier_documents document
      on document.id = line.supplier_document_id
     and document.tenant_id = line.tenant_id
     and document.venue_id = line.venue_id
    where line.tenant_id = p_tenant_id
      and line.venue_id = p_venue_id
      and line.inventory_item_id = p_inventory_item_id
      and line.normalized_unit_cost is not null
      and document.status = 'confirmed'
    order by
      coalesce(
        document.confirmed_at,
        document.document_date::timestamptz,
        document.created_at
      ) desc,
      line.id desc
    limit 3
  ) costs;
$$;

create function public.theoretical_inventory_item_cost(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_unit_id uuid,
  p_path uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_base_unit_id uuid;
  v_unit_cost numeric;
  v_recipe public.inventory_production_recipes%rowtype;
  v_line record;
  v_base_quantity numeric;
  v_component jsonb;
  v_cost numeric := 0;
  v_known boolean := false;
  v_components jsonb := '[]'::jsonb;
begin
  select item.base_unit_id
  into v_base_unit_id
  from public.inventory_items item
  where item.id = p_inventory_item_id
    and item.tenant_id = p_tenant_id
    and item.venue_id = p_venue_id;

  if v_base_unit_id is null
    or p_quantity is null
    or p_unit_id is null
  then
    return jsonb_build_object(
      'known', false,
      'cost', 0,
      'components', v_components
    );
  end if;

  if p_inventory_item_id = any(p_path) then
    return jsonb_build_object(
      'known', false,
      'cost', 0,
      'components', v_components
    );
  end if;

  v_base_quantity := public.inventory_convert_quantity(
    p_tenant_id,
    p_venue_id,
    p_quantity,
    p_unit_id,
    v_base_unit_id
  );

  v_unit_cost := public.theoretical_inventory_item_unit_cost(
    p_tenant_id,
    p_venue_id,
    p_inventory_item_id
  );

  select recipe.*
  into v_recipe
  from public.inventory_production_recipes recipe
  where recipe.tenant_id = p_tenant_id
    and recipe.venue_id = p_venue_id
    and recipe.inventory_item_id = p_inventory_item_id
    and recipe.is_active;

  if v_recipe.id is not null then
    for v_line in
      select
        line.inventory_item_id,
        line.quantity,
        line.unit_id,
        item.name,
        item.base_unit_id
      from public.inventory_production_recipe_lines line
      join public.inventory_items item
        on item.id = line.inventory_item_id
       and item.tenant_id = line.tenant_id
       and item.venue_id = line.venue_id
      where line.recipe_id = v_recipe.id
      order by line.sort_order, line.id
    loop
      v_component := public.theoretical_inventory_item_cost(
        p_tenant_id,
        p_venue_id,
        v_line.inventory_item_id,
        v_line.quantity * v_base_quantity / v_recipe.reference_quantity,
        v_line.unit_id,
        p_path || p_inventory_item_id
      );

      v_cost :=
        v_cost
        + coalesce((v_component ->> 'cost')::numeric, 0);

      v_known :=
        v_known
        or coalesce((v_component ->> 'known')::boolean, false);

      v_components := v_components || jsonb_build_array(
        jsonb_build_object(
          'inventoryItemId', v_line.inventory_item_id,
          'name', v_line.name,
          'quantity',
            v_line.quantity
            * v_base_quantity
            / v_recipe.reference_quantity,
          'unitId', v_line.unit_id,
          'unitCost',
            case
              when coalesce(
                (v_component ->> 'known')::boolean,
                false
              )
              then round(
                coalesce(
                  (v_component ->> 'cost')::numeric,
                  0
                )
                / nullif(
                    v_line.quantity
                    * v_base_quantity
                    / v_recipe.reference_quantity,
                    0
                  ),
                6
              )
              else null
            end,
          'cost',
            coalesce(
              (v_component ->> 'cost')::numeric,
              0
            ),
          'known',
            coalesce(
              (v_component ->> 'known')::boolean,
              false
            ),
          'components',
            coalesce(
              v_component -> 'components',
              '[]'::jsonb
            )
        )
      );
    end loop;

    return jsonb_build_object(
      'known', v_known,
      'cost', round(v_cost, 6),
      'components', v_components
    );
  end if;

  return jsonb_build_object(
    'known', v_unit_cost is not null,
    'cost',
      round(
        coalesce(v_unit_cost, 0) * v_base_quantity,
        6
      ),
    'components',
      jsonb_build_array(
        jsonb_build_object(
          'inventoryItemId', p_inventory_item_id,
          'quantity', v_base_quantity,
          'unitId', v_base_unit_id,
          'unitCost', v_unit_cost,
          'cost',
            round(
              coalesce(v_unit_cost, 0)
              * v_base_quantity,
              6
            ),
          'known', v_unit_cost is not null
        )
      )
  );
end;
$$;

create function public.theoretical_variant_cost(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_variant_id uuid,
  p_multiplier numeric default 1
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_line record;
  v_quantity numeric;
  v_component jsonb;
  v_cost numeric := 0;
  v_known boolean := false;
  v_components jsonb := '[]'::jsonb;
begin
  for v_line in
    select
      line.inventory_item_id,
      line.quantity,
      line.unit_id,
      line.uses_format_default,
      item.name,
      format.inventory_consumption_quantity,
      format.inventory_consumption_unit_id
    from public.inventory_recipes recipe
    join public.product_variants variant
      on variant.id = recipe.variant_id
     and variant.tenant_id = recipe.tenant_id
     and variant.venue_id = recipe.venue_id
    join public.inventory_recipe_lines line
      on line.recipe_id = recipe.id
     and line.tenant_id = recipe.tenant_id
     and line.venue_id = recipe.venue_id
    join public.inventory_items item
      on item.id = line.inventory_item_id
     and item.tenant_id = line.tenant_id
     and item.venue_id = line.venue_id
    left join public.catalog_sale_formats format
      on format.id = variant.catalog_sale_format_id
     and format.tenant_id = variant.tenant_id
     and format.venue_id = variant.venue_id
    where recipe.tenant_id = p_tenant_id
      and recipe.venue_id = p_venue_id
      and recipe.variant_id = p_variant_id
      and recipe.is_active
      and item.is_active
    order by line.sort_order, line.id
  loop
    v_quantity :=
      case
        when v_line.uses_format_default
          then v_line.inventory_consumption_quantity
        else v_line.quantity
      end;

    if v_quantity is null
      or (
        case
          when v_line.uses_format_default
            then v_line.inventory_consumption_unit_id
          else v_line.unit_id
        end
      ) is null
    then
      continue;
    end if;

    v_component := public.theoretical_inventory_item_cost(
      p_tenant_id,
      p_venue_id,
      v_line.inventory_item_id,
      v_quantity * p_multiplier,
      case
        when v_line.uses_format_default
          then v_line.inventory_consumption_unit_id
        else v_line.unit_id
      end
    );

    v_cost :=
      v_cost
      + coalesce((v_component ->> 'cost')::numeric, 0);

    v_known :=
      v_known
      or coalesce((v_component ->> 'known')::boolean, false);

    v_components := v_components || jsonb_build_array(
      jsonb_build_object(
        'inventoryItemId', v_line.inventory_item_id,
        'name', v_line.name,
        'quantity', v_quantity * p_multiplier,
        'unitId',
          case
            when v_line.uses_format_default
              then v_line.inventory_consumption_unit_id
            else v_line.unit_id
          end,
        'unitCost',
          case
            when coalesce(
              (v_component ->> 'known')::boolean,
              false
            )
            then round(
              coalesce(
                (v_component ->> 'cost')::numeric,
                0
              )
              / nullif(v_quantity * p_multiplier, 0),
              6
            )
            else null
          end,
        'cost',
          coalesce(
            (v_component ->> 'cost')::numeric,
            0
          ),
        'known',
          coalesce(
            (v_component ->> 'known')::boolean,
            false
          ),
        'components',
          coalesce(
            v_component -> 'components',
            '[]'::jsonb
          )
      )
    );
  end loop;

  return jsonb_build_object(
    'known', v_known,
    'cost', round(v_cost, 6),
    'components', v_components
  );
end;
$$;

create function public.set_ticket_line_theoretical_cost()
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
  if tg_op = 'UPDATE'
    and new.theoretical_cost_cents
      is not distinct from old.theoretical_cost_cents
    and new.theoretical_cost_known
      is not distinct from old.theoretical_cost_known
  then
    return new;
  end if;

  select ticket.venue_id
  into v_venue_id
  from public.tickets ticket
  where ticket.id = new.ticket_id
    and ticket.tenant_id = new.tenant_id;

  v_multiplier :=
    coalesce(
      new.allocated_quantity,
      new.quantity::numeric
    );

  v_cost := public.theoretical_variant_cost(
    new.tenant_id,
    v_venue_id,
    new.variant_id,
    v_multiplier
  );

  new.theoretical_cost_known :=
    coalesce(
      (v_cost ->> 'known')::boolean,
      false
    );

  new.theoretical_cost_cents :=
    case
      when new.theoretical_cost_known
      then round(
        coalesce(
          (v_cost ->> 'cost')::numeric,
          0
        ) * 100
      )::integer
      else null
    end;

  return new;
end;
$$;

create trigger set_ticket_line_theoretical_cost_trigger
before insert or update of
  tenant_id,
  ticket_id,
  variant_id,
  quantity,
  allocated_quantity
on public.ticket_lines
for each row
execute function public.set_ticket_line_theoretical_cost();

create function public.crm_profitability_report(
  p_venue_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_category_id uuid default null,
  p_product_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_result jsonb;
begin
  select venue.tenant_id
  into v_tenant_id
  from public.venues venue
  where venue.id = p_venue_id;

  if v_tenant_id is null
    or (
      not public.user_is_tenant_admin(v_tenant_id)
      and not public.user_has_venue_access(
        v_tenant_id,
        p_venue_id
      )
    )
  then
    raise exception 'PROFITABILITY_FORBIDDEN'
      using errcode = '42501';
  end if;

  with filtered as (
    select
      ticket.local_created_at,
      line.product_id,
      line.product_name,
      line.category_id_snapshot,
      coalesce(
        nullif(line.category_name_snapshot, ''),
        'Sin categoría'
      ) as category_name,
      coalesce(
        line.allocated_quantity,
        line.quantity::numeric
      ) as quantity,
      coalesce(
        line.taxable_base_cents,
        round(
          line.net_total_cents
          / (
            1
            + coalesce(line.tax_rate, 0) / 100
          )
        )
      )::integer as net_sales_cents,
      coalesce(
        line.taxable_base_cents,
        round(
          line.line_total_cents
          / (
            1
            + coalesce(line.tax_rate, 0) / 100
          )
        )
      )::integer as gross_sales_cents,
      greatest(
        coalesce(
          line.line_total_cents
          - line.net_total_cents,
          0
        ),
        0
      ) as discount_cents,
      line.theoretical_cost_cents,
      line.theoretical_cost_known
    from public.tickets ticket
    join public.ticket_lines line
      on line.ticket_id = ticket.id
     and line.tenant_id = ticket.tenant_id
    where ticket.tenant_id = v_tenant_id
      and ticket.venue_id = p_venue_id
      and ticket.status = 'paid'
      and ticket.local_created_at >= p_start_at
      and ticket.local_created_at < p_end_at
      and (
        p_category_id is null
        or line.category_id_snapshot = p_category_id
      )
      and (
        p_product_id is null
        or line.product_id = p_product_id
      )
  ),
  grouped as (
    select
      'product'::text as dimension,
      coalesce(
        product_id::text,
        'deleted:' || lower(product_name)
      ) as id,
      product_name as label,
      sum(quantity) as units,
      sum(net_sales_cents) as net_sales_cents,
      sum(gross_sales_cents) as gross_sales_cents,
      sum(discount_cents) as discounts_cents,
      sum(
        case
          when theoretical_cost_known
            then theoretical_cost_cents
          else 0
        end
      ) as theoretical_cost_cents,
      sum(
        case
          when theoretical_cost_known
            then net_sales_cents
          else 0
        end
      ) as known_net_sales_cents,
      sum(
        case
          when theoretical_cost_known
            then gross_sales_cents
          else 0
        end
      ) as known_gross_sales_cents,
      sum(
        case
          when theoretical_cost_known then 1
          else 0
        end
      ) as known_lines,
      count(*) as line_count
    from filtered
    group by product_id, product_name

    union all

    select
      'category',
      coalesce(
        category_id_snapshot::text,
        'uncategorized'
      ),
      category_name,
      sum(quantity),
      sum(net_sales_cents),
      sum(gross_sales_cents),
      sum(discount_cents),
      sum(
        case
          when theoretical_cost_known
            then theoretical_cost_cents
          else 0
        end
      ),
      sum(
        case
          when theoretical_cost_known
            then net_sales_cents
          else 0
        end
      ),
      sum(
        case
          when theoretical_cost_known
            then gross_sales_cents
          else 0
        end
      ),
      sum(
        case
          when theoretical_cost_known then 1
          else 0
        end
      ),
      count(*)
    from filtered
    group by
      category_id_snapshot,
      category_name
  ),
  totals as (
    select
      sum(net_sales_cents) as net_sales_cents,
      sum(gross_sales_cents) as gross_sales_cents,
      sum(discount_cents) as discounts_cents,
      sum(
        case
          when theoretical_cost_known
            then theoretical_cost_cents
          else 0
        end
      ) as theoretical_cost_cents,
      sum(
        case
          when theoretical_cost_known
            then net_sales_cents
          else 0
        end
      ) as known_net_sales_cents,
      sum(
        case
          when theoretical_cost_known
            then gross_sales_cents
          else 0
        end
      ) as known_gross_sales_cents,
      sum(
        case
          when theoretical_cost_known then 1
          else 0
        end
      ) as known_lines,
      count(*) as line_count
    from filtered
  )
  select jsonb_build_object(
    'summary',
      coalesce(
        (
          select to_jsonb(totals)
          from totals
        ),
        '{}'::jsonb
      ),
    'products',
      coalesce(
        (
          select jsonb_agg(
            to_jsonb(grouped)
            order by gross_sales_cents desc, label
          )
          from grouped
          where dimension = 'product'
        ),
        '[]'::jsonb
      ),
    'categories',
      coalesce(
        (
          select jsonb_agg(
            to_jsonb(grouped)
            order by gross_sales_cents desc, label
          )
          from grouped
          where dimension = 'category'
        ),
        '[]'::jsonb
      ),
    'timeline',
      coalesce(
        (
          select jsonb_agg(
            to_jsonb(points)
            order by day
          )
          from (
            select
              (
                local_created_at
                at time zone 'UTC'
              )::date::text as day,
              sum(net_sales_cents)
                as net_sales_cents,
              sum(gross_sales_cents)
                as gross_sales_cents,
              sum(
                case
                  when theoretical_cost_known
                    then theoretical_cost_cents
                  else 0
                end
              ) as theoretical_cost_cents,
              sum(
                case
                  when theoretical_cost_known
                    then net_sales_cents
                  else 0
                end
              ) as known_net_sales_cents,
              sum(
                case
                  when theoretical_cost_known
                    then gross_sales_cents
                  else 0
                end
              ) as known_gross_sales_cents
            from filtered
            group by 1
          ) points
        ),
        '[]'::jsonb
      )
  )
  into v_result;

  return v_result;
end;
$$;

create function public.crm_current_product_profitability(
  p_venue_id uuid,
  p_product_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_variant record;
  v_cost jsonb;
begin
  select venue.tenant_id
  into v_tenant_id
  from public.venues venue
  where venue.id = p_venue_id;

  if v_tenant_id is null
    or (
      not public.user_is_tenant_admin(v_tenant_id)
      and not public.user_has_venue_access(
        v_tenant_id,
        p_venue_id
      )
    )
  then
    raise exception 'PROFITABILITY_FORBIDDEN'
      using errcode = '42501';
  end if;

  select
    variant.id,
    variant.name,
    variant.price_cents
  into v_variant
  from public.product_variants variant
  where variant.tenant_id = v_tenant_id
    and variant.venue_id = p_venue_id
    and variant.product_id = p_product_id
    and variant.is_active
  order by
    variant.is_default desc,
    variant.sort_order,
    variant.id
  limit 1;

  if v_variant.id is null then
    return null;
  end if;

  v_cost := public.theoretical_variant_cost(
    v_tenant_id,
    p_venue_id,
    v_variant.id,
    1
  );

  return jsonb_build_object(
    'variantId', v_variant.id,
    'variantName', v_variant.name,
    'priceCents', v_variant.price_cents,
    'costCents',
      case
        when coalesce(
          (v_cost ->> 'known')::boolean,
          false
        )
        then round(
          coalesce(
            (v_cost ->> 'cost')::numeric,
            0
          ) * 100
        )::integer
        else null
      end,
    'costKnown',
      coalesce(
        (v_cost ->> 'known')::boolean,
        false
      ),
    'components',
      coalesce(
        v_cost -> 'components',
        '[]'::jsonb
      )
  );
end;
$$;

revoke all on function
  public.theoretical_inventory_item_unit_cost(
    uuid,
    uuid,
    uuid
  ),
  public.theoretical_inventory_item_cost(
    uuid,
    uuid,
    uuid,
    numeric,
    uuid,
    uuid[]
  ),
  public.theoretical_variant_cost(
    uuid,
    uuid,
    uuid,
    numeric
  ),
  public.set_ticket_line_theoretical_cost()
from public, anon, authenticated;

revoke all on function
  public.crm_profitability_report(
    uuid,
    timestamptz,
    timestamptz,
    uuid,
    uuid
  ),
  public.crm_current_product_profitability(
    uuid,
    uuid
  )
from public, anon;

grant execute on function
  public.crm_profitability_report(
    uuid,
    timestamptz,
    timestamptz,
    uuid,
    uuid
  ),
  public.crm_current_product_profitability(
    uuid,
    uuid
  )
to authenticated;

comment on column
  public.ticket_lines.theoretical_cost_cents
is
  'Immutable theoretical cost snapshot in cents captured on sale creation; null means no cost data existed.';

comment on column
  public.ticket_lines.theoretical_cost_known
is
  'Whether the sale line had at least one known cost component at creation.';
