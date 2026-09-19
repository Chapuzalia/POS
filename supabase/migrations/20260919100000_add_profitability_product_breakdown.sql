-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Restricts only the new read-only profitability detail RPC; the existing RPC and its access remain unchanged.

create function public.crm_product_profitability_detail(
  p_venue_id uuid,
  p_product_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz
)
returns jsonb
language plpgsql
stable
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
      and not public.user_has_venue_access(v_tenant_id, p_venue_id)
    )
  then
    raise exception 'PROFITABILITY_FORBIDDEN' using errcode = '42501';
  end if;

  with active_variants as (
    select
      variant.id,
      variant.name,
      variant.price_cents,
      variant.sort_order,
      variant.is_default,
      format.name as format_name
    from public.product_variants variant
    left join public.catalog_sale_formats format
      on format.id = variant.catalog_sale_format_id
     and format.tenant_id = variant.tenant_id
     and format.venue_id = variant.venue_id
    where variant.tenant_id = v_tenant_id
      and variant.venue_id = p_venue_id
      and variant.product_id = p_product_id
      and variant.is_active
  ), current_variants as (
    select
      variant.*,
      public.theoretical_variant_cost(v_tenant_id, p_venue_id, variant.id, 1) as cost
    from active_variants variant
  ),
  historical_lines as (
    select
      line.id,
      line.tenant_id,
      line.variant_id,
      coalesce(nullif(line.sale_format_name_snapshot, ''), nullif(line.variant_name, ''), 'Sin formato') as format_name,
      coalesce(line.allocated_quantity, line.quantity::numeric) as quantity,
      coalesce(line.taxable_base_cents, round(line.net_total_cents / (1 + coalesce(line.tax_rate, 0) / 100)))::integer as net_sales_cents,
      coalesce(line.taxable_base_cents, round(line.line_total_cents / (1 + coalesce(line.tax_rate, 0) / 100)))::integer as gross_sales_cents,
      greatest(coalesce(line.line_total_cents - line.net_total_cents, 0), 0) as discount_cents,
      line.theoretical_cost_cents,
      line.theoretical_cost_known,
      line.modifiers
    from public.tickets ticket
    join public.ticket_lines line
      on line.ticket_id = ticket.id
     and line.tenant_id = ticket.tenant_id
    where ticket.tenant_id = v_tenant_id
      and ticket.venue_id = p_venue_id
      and ticket.status = 'paid'
      and ticket.local_created_at >= p_start_at
      and ticket.local_created_at < p_end_at
      and line.product_id = p_product_id
  ),
  variant_breakdown as (
    select
      coalesce(lines.variant_id::text, 'unknown') as variant_key,
      lines.format_name,
      sum(lines.quantity) as units,
      sum(lines.net_sales_cents) as net_sales_cents,
      sum(lines.gross_sales_cents) as gross_sales_cents,
      sum(lines.discount_cents) as discounts_cents,
      sum(case when lines.theoretical_cost_known then lines.theoretical_cost_cents else 0 end) as theoretical_cost_cents,
      sum(case when lines.theoretical_cost_known then lines.net_sales_cents else 0 end) as known_net_sales_cents,
      sum(case when lines.theoretical_cost_known then lines.gross_sales_cents else 0 end) as known_gross_sales_cents,
      sum(case when lines.theoretical_cost_known then 1 else 0 end) as known_lines,
      count(*) as line_count
    from historical_lines lines
    group by coalesce(lines.variant_id::text, 'unknown'), lines.format_name
  ),
  persisted_mixers as (
    select
      lines.id as line_id,
      coalesce(lines.variant_id::text, 'unknown') as variant_key,
      lines.format_name,
      coalesce(nullif(component.product_name_snapshot, ''), nullif(component.variant_name_snapshot, ''), 'Sin nombre') as mixer_name,
      lines.quantity * component.quantity as units,
      lines.net_sales_cents,
      lines.gross_sales_cents
    from historical_lines lines
    join public.ticket_line_components component
      on component.ticket_line_id = lines.id
     and component.tenant_id = lines.tenant_id
     and component.component_type = 'mixer'
  ),
  legacy_mixers as (
    select
      lines.id as line_id,
      coalesce(lines.variant_id::text, 'unknown') as variant_key,
      lines.format_name,
      coalesce(nullif(modifier.value ->> 'name', ''), 'Mixer') as mixer_name,
      lines.quantity as units,
      lines.net_sales_cents,
      lines.gross_sales_cents
    from historical_lines lines
    cross join lateral jsonb_array_elements(coalesce(lines.modifiers, '[]'::jsonb)) modifier(value)
    where modifier.value ->> 'id' ~* '^mixer:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and not exists (
        select 1
        from persisted_mixers persisted
        where persisted.line_id = lines.id
      )
  ),
  mixer_breakdown as (
    select
      mixer.variant_key,
      mixer.format_name,
      mixer.mixer_name,
      sum(mixer.units) as units,
      sum(mixer.net_sales_cents) as net_sales_cents,
      sum(mixer.gross_sales_cents) as gross_sales_cents,
      count(*) as line_count
    from (
      select * from persisted_mixers
      union all
      select * from legacy_mixers
    ) mixer
    group by mixer.variant_key, mixer.format_name, mixer.mixer_name
  ),
  variant_json as (
    select jsonb_agg(
      jsonb_build_object(
        'variantId', variant.id,
        'variantName', variant.name,
        'formatName', variant.format_name,
        'priceCents', variant.price_cents,
        'costCents', case when coalesce((variant.cost ->> 'known')::boolean, false)
          then round(coalesce((variant.cost ->> 'cost')::numeric, 0) * 100)::integer
          else null end,
        'costKnown', coalesce((variant.cost ->> 'known')::boolean, false),
        'components', coalesce(variant.cost -> 'components', '[]'::jsonb)
      )
      order by variant.is_default desc, variant.sort_order, variant.id
    ) as variants
    from current_variants variant
  ),
  breakdown_json as (
    select jsonb_agg(
      jsonb_build_object(
        'variantId', breakdown.variant_key,
        'formatName', breakdown.format_name,
        'units', breakdown.units,
        'netSalesCents', breakdown.net_sales_cents,
        'grossSalesCents', breakdown.gross_sales_cents,
        'discountsCents', breakdown.discounts_cents,
        'theoreticalCostCents', breakdown.theoretical_cost_cents,
        'knownNetSalesCents', breakdown.known_net_sales_cents,
        'knownGrossSalesCents', breakdown.known_gross_sales_cents,
        'knownLines', breakdown.known_lines,
        'lineCount', breakdown.line_count,
        'mixers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', mixer.mixer_name,
            'units', mixer.units,
            'netSalesCents', mixer.net_sales_cents,
            'grossSalesCents', mixer.gross_sales_cents,
            'lineCount', mixer.line_count
          ) order by mixer.units desc, mixer.mixer_name)
          from mixer_breakdown mixer
          where mixer.variant_key = breakdown.variant_key
            and mixer.format_name = breakdown.format_name
        ), '[]'::jsonb)
      ) order by breakdown.units desc, breakdown.format_name
    ) as breakdown
    from variant_breakdown breakdown
  )
  select jsonb_build_object(
    'variants', coalesce((select variants from variant_json), '[]'::jsonb),
    'breakdown', coalesce((select breakdown from breakdown_json), '[]'::jsonb),
    'variantId', default_variant.id,
    'variantName', default_variant.name,
    'priceCents', default_variant.price_cents,
    'costCents', case when coalesce((default_variant.cost ->> 'known')::boolean, false)
      then round(coalesce((default_variant.cost ->> 'cost')::numeric, 0) * 100)::integer
      else null end,
    'costKnown', coalesce((default_variant.cost ->> 'known')::boolean, false),
    'components', coalesce(default_variant.cost -> 'components', '[]'::jsonb)
  )
  into v_result
  from current_variants default_variant
  order by default_variant.is_default desc, default_variant.sort_order, default_variant.id
  limit 1;

  v_result := coalesce(v_result, jsonb_build_object(
    'variants', coalesce((select variants from variant_json), '[]'::jsonb),
    'breakdown', coalesce((select breakdown from breakdown_json), '[]'::jsonb)
  ));

  return v_result;
end;
$$;

revoke all on function public.crm_product_profitability_detail(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_product_profitability_detail(uuid, uuid, timestamptz, timestamptz) to authenticated;
