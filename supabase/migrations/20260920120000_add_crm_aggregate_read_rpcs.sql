-- migration-safety: expand
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Restricts only new read-only CRM aggregate RPCs to authenticated roles; existing contracts and RLS remain unchanged.
set lock_timeout = '5s';
set statement_timeout = '5min';

create function public.crm_stats_period(
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
  with paid_tickets as (
    select t.id, t.local_created_at, t.total_cents,
      coalesce(t.discount_amount_cents, 0)::bigint as discount_amount_cents,
      t.discount_id, t.discount_name
    from public.tickets t
    where t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
      and t.status = 'paid' and t.local_created_at >= p_period_start and t.local_created_at < p_period_end
  ), paid_lines as (
    select tl.id, tl.product_id, tl.product_name, tl.category_id_snapshot, tl.category_name_snapshot,
      coalesce(tl.allocated_quantity, tl.quantity::numeric) as quantity, tl.line_total_cents,
      tl.modifiers,
      coalesce((select jsonb_agg(jsonb_build_object('type', c.component_type, 'productName', c.product_name_snapshot, 'sortOrder', c.sort_order, 'modifiers', coalesce(c.metadata -> 'modifiers', '[]'::jsonb)) order by c.sort_order, c.id)
        from public.ticket_line_components c where c.ticket_line_id = tl.id and c.tenant_id = p_tenant_id), '[]'::jsonb) as components
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
  ), combinations as (
    select product_name,
      coalesce((select jsonb_agg(name order by lower(name)) from (select distinct btrim(value ->> 'productName') name from jsonb_array_elements(components) where value ->> 'type' = 'mixer' and nullif(btrim(value ->> 'productName'), '') is not null) x), '[]'::jsonb) mixers,
      coalesce((select jsonb_agg(name order by lower(name)) from (select distinct btrim(value ->> 'name') name from jsonb_array_elements(coalesce(modifiers, '[]'::jsonb)) where coalesce(value ->> 'groupId', '') <> 'mixer' and coalesce(value ->> 'id', '') not like 'mixer:%' and nullif(btrim(value ->> 'name'), '') is not null) x), '[]'::jsonb) modifiers,
      sum(quantity) quantity, sum(line_total_cents)::bigint total_cents
    from paid_lines group by product_name, components, modifiers
  ), grouped_combinations as (
    select product_name, mixers, modifiers, sum(quantity) quantity, sum(total_cents)::bigint total_cents
    from combinations group by product_name, mixers, modifiers
  ), discounts as (
    select coalesce(discount_id::text, 'manual') id, discount_name name, count(*) applications,
      sum(discount_amount_cents)::bigint discounted_cents, sum(total_cents)::bigint net_sales_cents
    from paid_tickets where discount_name is not null and discount_amount_cents > 0 group by 1, 2
  ), hourly as (
    select extract(hour from (local_created_at at time zone p_time_zone))::integer as hour_of_day, count(*) as ticket_count, sum(total_cents)::bigint as total_cents
    from paid_tickets group by 1
  ), open_days as (
    select distinct ((local_created_at at time zone p_time_zone)::date - case when (local_created_at at time zone p_time_zone)::time < coalesce(p_day_change_time, time '00:00') then 1 else 0 end)::date day_key from paid_tickets
    union
    select distinct ((opened_at at time zone p_time_zone)::date - case when (opened_at at time zone p_time_zone)::time < coalesce(p_day_change_time, time '00:00') then 1 else 0 end)::date
    from public.cash_sessions where tenant_id = p_tenant_id and venue_id = p_venue_id and opened_at >= p_period_start and opened_at < p_period_end
  ), payment_totals as (
    select payment_method method, sum(total_cents)::bigint total_cents, count(*) count
    from public.sales where tenant_id = p_tenant_id and venue_id = p_venue_id and local_created_at >= p_period_start and local_created_at < p_period_end and payment_method in ('cash', 'card')
    group by payment_method
  )
  select jsonb_build_object(
    'averageTicketCents', coalesce(round(sum(pt.total_cents)::numeric / nullif(count(*), 0)), 0),
    'byPayment', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'totalCents', total_cents, 'count', count) order by total_cents desc) from payment_totals), '[]'::jsonb),
    'discountApplications', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'applications', applications, 'discountedCents', discounted_cents, 'netSalesCents', net_sales_cents, 'ticketPercentage', round(applications::numeric * 1000 / nullif((select count(*) from paid_tickets), 0)) / 10) order by discounted_cents desc) from discounts), '[]'::jsonb),
    'discountedTicketCount', count(*) filter (where discount_amount_cents > 0),
    'discountsCents', coalesce(sum(discount_amount_cents), 0)::bigint,
    'hourlySales', coalesce((select jsonb_agg(jsonb_build_object('hour', hour_series.hour_of_day, 'ticketCount', coalesce(x.ticket_count, 0), 'totalCents', coalesce(x.total_cents, 0)) order by hour_series.hour_of_day) from generate_series(0, 23) as hour_series(hour_of_day) left join hourly x on x.hour_of_day = hour_series.hour_of_day), '[]'::jsonb),
    'monthKey', to_char(p_period_start_date, 'YYYY-MM'), 'monthSalesCents', coalesce(sum(pt.total_cents), 0)::bigint, 'monthTicketCount', count(*),
    'period', jsonb_build_object('kind', p_period_kind, 'startDate', p_period_start_date, 'endDate', p_period_end_date, 'effectiveEndDate', p_effective_end_date, 'dayCount', p_period_end_date - p_period_start_date + 1, 'openDayCount', (select count(*) from open_days)),
    'salesByCategory', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'quantity', quantity, 'totalCents', total_cents) order by total_cents desc, quantity desc, label) from categories), '[]'::jsonb),
    'salesByProduct', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'label', label, 'quantity', quantity, 'totalCents', total_cents) order by total_cents desc, quantity desc, label) from products), '[]'::jsonb),
    'topProducts', coalesce((select jsonb_agg(jsonb_build_object('productName', label, 'quantity', quantity, 'totalCents', total_cents) order by quantity desc, total_cents desc, label) from (select * from products order by quantity desc, total_cents desc, label limit 8) x), '[]'::jsonb),
    'topProductCombinations', coalesce((select jsonb_agg(jsonb_build_object('productName', product_name, 'mixers', mixers, 'modifiers', modifiers, 'quantity', quantity, 'totalCents', total_cents) order by quantity desc, total_cents desc, product_name) from (select * from grouped_combinations order by quantity desc, total_cents desc, product_name limit 8) x), '[]'::jsonb),
    'dayActivity', jsonb_build_object('totalCents', 0, 'cashCents', 0, 'cardCents', 0, 'ticketCount', 0), 'openCashSessions', '[]'::jsonb
  ) from paid_tickets pt;
$$;

create function public.crm_stats_live(p_tenant_id uuid, p_venue_id uuid, p_day_start timestamptz, p_day_end timestamptz)
returns jsonb language sql stable parallel safe security invoker set search_path = '' as $$
  with day_tickets as (select id, total_cents from public.tickets where tenant_id = p_tenant_id and venue_id = p_venue_id and status = 'paid' and local_created_at >= p_day_start and local_created_at < p_day_end),
  day_sales as (select payment_method, total_cents from public.sales where tenant_id = p_tenant_id and venue_id = p_venue_id and local_created_at >= p_day_start and local_created_at < p_day_end),
  sessions as (select cs.id, cs.venue_id, coalesce(v.name, 'Local sin nombre') venue_name, coalesce(d.name, 'Caja sin nombre') device_name, cs.opened_at, cs.opening_float_cents from public.cash_sessions cs left join public.venues v on v.id = cs.venue_id and v.tenant_id = p_tenant_id left join public.devices d on d.id = cs.device_id and d.tenant_id = p_tenant_id where cs.tenant_id = p_tenant_id and cs.venue_id = p_venue_id and cs.status = 'open'),
  session_totals as (select s.*, coalesce(sum(x.total_cents), 0)::bigint sales_cents, count(x.*) ticket_count, coalesce(sum(x.total_cents) filter (where x.payment_method = 'cash'), 0)::bigint cash_cents, coalesce(sum(x.total_cents) filter (where x.payment_method = 'card'), 0)::bigint card_cents, coalesce(sum(x.total_cents) filter (where x.payment_method = 'invitation'), 0)::bigint invitation_cents, coalesce(sum(x.total_cents) filter (where x.payment_method not in ('cash', 'card', 'invitation') or x.payment_method is null), 0)::bigint other_cents from sessions s left join public.sales x on x.cash_session_id = s.id and x.tenant_id = p_tenant_id group by s.id, s.venue_id, s.venue_name, s.device_name, s.opened_at, s.opening_float_cents)
  select jsonb_build_object('dayActivity', jsonb_build_object('totalCents', coalesce((select sum(total_cents) from day_tickets), 0), 'cashCents', coalesce((select sum(total_cents) from day_sales where payment_method = 'cash'), 0), 'cardCents', coalesce((select sum(total_cents) from day_sales where payment_method = 'card'), 0), 'ticketCount', (select count(*) from day_tickets)), 'openCashSessions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'venueId', venue_id, 'venueName', venue_name, 'deviceName', device_name, 'openedAt', opened_at, 'openingFloatCents', opening_float_cents, 'salesCents', sales_cents, 'ticketCount', ticket_count, 'cashCents', cash_cents, 'cardCents', card_cents, 'invitationCents', invitation_cents, 'otherCents', other_cents) order by opened_at desc) from session_totals), '[]'::jsonb));
$$;

revoke all on function public.crm_stats_period(uuid, uuid, text, date, date, date, timestamptz, timestamptz, text, time) from public, anon;
grant execute on function public.crm_stats_period(uuid, uuid, text, date, date, date, timestamptz, timestamptz, text, time) to authenticated, service_role;
revoke all on function public.crm_stats_live(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_stats_live(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
