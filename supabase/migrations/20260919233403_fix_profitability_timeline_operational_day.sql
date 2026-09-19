-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserves the existing RPC signature, permissions and response contract while grouping timeline points by the venue operational day.

create or replace function public.crm_profitability_report(
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
  v_time_zone text;
  v_day_change_offset interval;
  v_result jsonb;
begin
  select
    venue.tenant_id,
    coalesce(venue.timezone, 'Europe/Madrid'),
    coalesce(venue.day_change_time, time '00:00') - time '00:00'
  into
    v_tenant_id,
    v_time_zone,
    v_day_change_offset
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
                (
                  local_created_at
                  at time zone v_time_zone
                )
                - v_day_change_offset
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
