-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Restricts only the new read-only profitability combinations RPC to authenticated roles.

create function public.crm_product_profitability_combinations(
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

  with historical_lines as (
    select
      line.id,
      line.tenant_id,
      coalesce(line.variant_id::text, 'unknown') as variant_key,
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
  ), selections as (
    select
      lines.id as line_id,
      'mixer'::text as selection_type,
      coalesce(nullif(component.product_name_snapshot, ''), nullif(component.variant_name_snapshot, ''), 'Mixer') as name
    from historical_lines lines
    join public.ticket_line_components component
      on component.ticket_line_id = lines.id
     and component.tenant_id = lines.tenant_id
     and component.component_type = 'mixer'

    union all

    select
      lines.id,
      'modifier',
      coalesce(nullif(modifier.value ->> 'name', ''), 'Modificador')
    from historical_lines lines
    cross join lateral jsonb_array_elements(coalesce(lines.modifiers, '[]'::jsonb)) modifier(value)
    where coalesce(modifier.value ->> 'id', '') !~* '^mixer:'

    union all

    select
      lines.id,
      'modifier',
      coalesce(nullif(modifier.value ->> 'name', ''), 'Modificador')
    from historical_lines lines
    join public.ticket_line_components component
      on component.ticket_line_id = lines.id
     and component.tenant_id = lines.tenant_id
    cross join lateral jsonb_array_elements(coalesce(component.metadata -> 'modifiers', '[]'::jsonb)) modifier(value)

    union all

    select
      lines.id,
      'mixer',
      coalesce(nullif(modifier.value ->> 'name', ''), 'Mixer')
    from historical_lines lines
    cross join lateral jsonb_array_elements(coalesce(lines.modifiers, '[]'::jsonb)) modifier(value)
    where modifier.value ->> 'id' ~* '^mixer:'
      and not exists (
        select 1
        from public.ticket_line_components component
        where component.ticket_line_id = lines.id
          and component.tenant_id = lines.tenant_id
          and component.component_type = 'mixer'
      )
  ), line_combinations as (
    select
      lines.*,
      coalesce(string_agg(selection.name, ' + ' order by selection.selection_type, selection.name), 'Sin mixer ni modificadores') as combination_name,
      coalesce(jsonb_agg(jsonb_build_object('type', selection.selection_type, 'name', selection.name)
        order by selection.selection_type, selection.name) filter (where selection.name is not null), '[]'::jsonb) as selections
    from historical_lines lines
    left join selections selection on selection.line_id = lines.id
    group by lines.id, lines.tenant_id, lines.variant_key, lines.format_name, lines.quantity,
      lines.net_sales_cents, lines.gross_sales_cents, lines.discount_cents,
      lines.theoretical_cost_cents, lines.theoretical_cost_known, lines.modifiers
  ), grouped as (
    select
      variant_key,
      format_name,
      combination_name,
      selections,
      sum(quantity) as units,
      sum(net_sales_cents) as net_sales_cents,
      sum(gross_sales_cents) as gross_sales_cents,
      sum(discount_cents) as discounts_cents,
      sum(case when theoretical_cost_known then theoretical_cost_cents else 0 end) as theoretical_cost_cents,
      sum(case when theoretical_cost_known then net_sales_cents else 0 end) as known_net_sales_cents,
      sum(case when theoretical_cost_known then gross_sales_cents else 0 end) as known_gross_sales_cents,
      sum(case when theoretical_cost_known then 1 else 0 end) as known_lines,
      count(*) as line_count
    from line_combinations
    group by variant_key, format_name, combination_name, selections
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'variantId', grouped.variant_key,
    'formatName', grouped.format_name,
    'name', grouped.combination_name,
    'selections', grouped.selections,
    'units', grouped.units,
    'netSalesCents', grouped.net_sales_cents,
    'grossSalesCents', grouped.gross_sales_cents,
    'discountsCents', grouped.discounts_cents,
    'theoreticalCostCents', grouped.theoretical_cost_cents,
    'knownNetSalesCents', grouped.known_net_sales_cents,
    'knownGrossSalesCents', grouped.known_gross_sales_cents,
    'knownLines', grouped.known_lines,
    'lineCount', grouped.line_count
  ) order by grouped.units desc, grouped.combination_name), '[]'::jsonb)
  into v_result
  from grouped;

  return v_result;
end;
$$;

revoke all on function public.crm_product_profitability_combinations(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_product_profitability_combinations(uuid, uuid, timestamptz, timestamptz) to authenticated;
