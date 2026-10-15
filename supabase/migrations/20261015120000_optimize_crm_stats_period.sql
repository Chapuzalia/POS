-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve the CRM period RPC signature, JSON results, invoker RLS and existing grants while replacing per-row lookups with scoped aggregates.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- The historical schema has no sale_id lookup index on sale_payments.
-- Also serves the existing live-stats RPC without changing its contract.
create index if not exists sale_payments_tenant_sale_stats_idx
  on public.sale_payments (tenant_id, sale_id) include (method, amount_cents);

create index if not exists ticket_line_components_tenant_mixer_stats_idx
  on public.ticket_line_components (tenant_id, ticket_line_id)
  where component_type = 'mixer';

create index if not exists cash_sessions_tenant_venue_opened_stats_idx
  on public.cash_sessions (tenant_id, venue_id, opened_at);

create or replace function public.crm_stats_period(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_period_kind text,
  p_period_start_date date,
  p_period_end_date date,
  p_effective_end_date date,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_time_zone text,
  p_day_change_time time without time zone default null
)
returns jsonb
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  with paid_tickets as materialized (
    select t.id, t.local_created_at, t.total_cents,
      coalesce(t.discount_amount_cents, 0)::bigint as discount_amount_cents,
      t.discount_id, t.discount_name
    from public.tickets t
    where t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
      and t.status = 'paid' and t.local_created_at >= p_period_start and t.local_created_at < p_period_end
  ), ticket_totals as (
    select count(*) ticket_count, coalesce(sum(total_cents), 0)::bigint total_cents,
      count(*) filter (where discount_amount_cents > 0) discounted_ticket_count,
      coalesce(sum(discount_amount_cents), 0)::bigint discounts_cents
    from paid_tickets
  ), paid_lines as materialized (
    -- Keep shared line data narrow: no component metadata/JSON per sold line.
    select tl.id, tl.product_id, tl.product_name, tl.category_id_snapshot, tl.category_name_snapshot,
      coalesce(tl.allocated_quantity, tl.quantity::numeric) as quantity, tl.line_total_cents,
      coalesce(tl.modifiers, '[]'::jsonb) as modifiers
    from public.ticket_lines tl join paid_tickets pt on pt.id = tl.ticket_id
    where tl.tenant_id = p_tenant_id
  ), categories as (
    select coalesce(category_id_snapshot::text, 'uncategorized') id, coalesce(nullif(btrim(category_name_snapshot), ''), 'Sin categoría') label,
      sum(quantity) quantity, sum(line_total_cents)::bigint total_cents
    from paid_lines group by 1, 2
  ), products as (
    select coalesce(product_id::text, 'deleted:' || lower(btrim(product_name))) id, coalesce(nullif(btrim(product_name), ''), 'Producto sin nombre') label,
      sum(quantity) quantity, sum(line_total_cents)::bigint total_cents
    from paid_lines group by 1, 2
  ), mixer_names as (
    select distinct c.ticket_line_id, btrim(c.product_name_snapshot) name
    from public.ticket_line_components c join paid_lines pl on pl.id = c.ticket_line_id
    where c.tenant_id = p_tenant_id and c.component_type = 'mixer'
      and nullif(btrim(c.product_name_snapshot), '') is not null
  ), line_mixers as (
    select ticket_line_id, jsonb_agg(name order by lower(name)) mixers
    from mixer_names group by ticket_line_id
  ), modifier_sets as materialized (
    -- Repeated modifier snapshots are normalized once, rather than once per sale.
    select distinct modifiers from paid_lines
  ), normalized_modifiers as materialized (
    select ms.modifiers snapshot,
      coalesce((select jsonb_agg(name order by lower(name)) from (
        select distinct btrim(value ->> 'name') name
        from jsonb_array_elements(ms.modifiers)
        where coalesce(value ->> 'groupId', '') <> 'mixer'
          and coalesce(value ->> 'id', '') not like 'mixer:%'
          and nullif(btrim(value ->> 'name'), '') is not null
      ) x), '[]'::jsonb) modifiers
    from modifier_sets ms
  ), grouped_combinations as (
    select pl.product_name, coalesce(lm.mixers, '[]'::jsonb) mixers, nm.modifiers,
      sum(pl.quantity) quantity, sum(pl.line_total_cents)::bigint total_cents
    from paid_lines pl
    left join line_mixers lm on lm.ticket_line_id = pl.id
    join normalized_modifiers nm on nm.snapshot = pl.modifiers
    group by pl.product_name, coalesce(lm.mixers, '[]'::jsonb), nm.modifiers
  ), discounts as (
    select coalesce(discount_id::text, 'manual') id, discount_name name, count(*) applications,
      sum(discount_amount_cents)::bigint discounted_cents, sum(total_cents)::bigint net_sales_cents
    from paid_tickets where discount_name is not null and discount_amount_cents > 0 group by 1, 2
  ), hourly as (
    select extract(hour from (local_created_at at time zone p_time_zone))::integer as hour_of_day, count(*) as ticket_count, sum(total_cents)::bigint as total_cents
    from paid_tickets group by 1
  ), open_days as (
    select ((local_created_at at time zone p_time_zone)::date - case when (local_created_at at time zone p_time_zone)::time < coalesce(p_day_change_time, time '00:00') then 1 else 0 end)::date day_key from paid_tickets
    union
    select ((opened_at at time zone p_time_zone)::date - case when (opened_at at time zone p_time_zone)::time < coalesce(p_day_change_time, time '00:00') then 1 else 0 end)::date
    from public.cash_sessions where tenant_id = p_tenant_id and venue_id = p_venue_id and opened_at >= p_period_start and opened_at < p_period_end
  ), sale_tenders as (
    -- One join handles mixed tenders and legacy sales with no payment rows.
    -- Keep unsupported payment methods until after the join: they must not
    -- cause a legacy fallback or multiply the ticket/line aggregates.
    select s.id sale_id,
      case when p.sale_id is null then s.payment_method else p.method end method,
      case when p.sale_id is null then s.total_cents else p.amount_cents end amount_cents
    from public.sales s
    left join public.sale_payments p on p.sale_id = s.id and p.tenant_id = p_tenant_id
    where s.tenant_id = p_tenant_id and s.venue_id = p_venue_id
      and s.local_created_at >= p_period_start and s.local_created_at < p_period_end
  ), payment_totals as (
    select method, sum(amount_cents)::bigint total_cents, count(distinct sale_id) count
    from sale_tenders where method in ('cash', 'card') group by method
  )
  select jsonb_build_object(
    'averageTicketCents', coalesce(round(tt.total_cents::numeric / nullif(tt.ticket_count, 0)), 0),
    'byPayment', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'totalCents', total_cents, 'count', count) order by total_cents desc) from payment_totals), '[]'::jsonb),
    'discountApplications', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'applications', applications, 'discountedCents', discounted_cents, 'netSalesCents', net_sales_cents, 'ticketPercentage', round(applications::numeric * 1000 / nullif(tt.ticket_count, 0)) / 10) order by discounted_cents desc) from discounts), '[]'::jsonb),
    'discountedTicketCount', tt.discounted_ticket_count,
    'discountsCents', tt.discounts_cents,
    'hourlySales', coalesce((select jsonb_agg(jsonb_build_object('hour', hour_series.hour_of_day, 'ticketCount', coalesce(x.ticket_count, 0), 'totalCents', coalesce(x.total_cents, 0)) order by hour_series.hour_of_day) from generate_series(0, 23) as hour_series(hour_of_day) left join hourly x on x.hour_of_day = hour_series.hour_of_day), '[]'::jsonb),
    'monthKey', to_char(p_period_start_date, 'YYYY-MM'), 'monthSalesCents', tt.total_cents, 'monthTicketCount', tt.ticket_count,
    'period', jsonb_build_object('kind', p_period_kind, 'startDate', p_period_start_date, 'endDate', p_period_end_date, 'effectiveEndDate', p_effective_end_date, 'dayCount', p_period_end_date - p_period_start_date + 1, 'openDayCount', (select count(*) from open_days)),
    'salesByCategory', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'quantity', quantity, 'totalCents', total_cents) order by total_cents desc, quantity desc, label) from categories), '[]'::jsonb),
    'salesByProduct', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'quantity', quantity, 'totalCents', total_cents) order by total_cents desc, quantity desc, label) from products), '[]'::jsonb),
    'topProducts', coalesce((select jsonb_agg(jsonb_build_object('productName', label, 'quantity', quantity, 'totalCents', total_cents) order by quantity desc, total_cents desc, label) from (select * from products order by quantity desc, total_cents desc, label limit 8) x), '[]'::jsonb),
    'topProductCombinations', coalesce((select jsonb_agg(jsonb_build_object('productName', product_name, 'mixers', mixers, 'modifiers', modifiers, 'quantity', quantity, 'totalCents', total_cents) order by quantity desc, total_cents desc, product_name) from (select * from grouped_combinations order by quantity desc, total_cents desc, product_name limit 8) x), '[]'::jsonb),
    'dayActivity', jsonb_build_object('totalCents', 0, 'cashCents', 0, 'cardCents', 0, 'ticketCount', 0), 'openCashSessions', '[]'::jsonb
  ) from ticket_totals tt;
$$;
