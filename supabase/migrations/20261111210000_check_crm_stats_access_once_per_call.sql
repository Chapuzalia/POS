-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Same signatures, results and grants for the CRM statistics, dashboard live and POS product-stats read RPCs; only the access check moves from per-row RLS to one equivalent check per call.

-- Same fix as 20261111200000 for the remaining read RPCs that still ran as
-- invoker: the statistics page (crm_stats_period, crm_stats_live), the
-- dashboard live state (crm_stats_live) and the POS product ranking
-- (pos_product_sales_stats). RLS evaluated the security-definer access helpers
-- for every ticket, line, component, sale and payment row, so busy venues hit
-- the statement timeout. Access rules are those of the SELECT policies:
--   tenant admin (owner/manager) or gestor: whole tenant;
--   venue access (assigned user): only that venue's rows.
-- Open cash sessions keep covering every venue the caller can read.

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
security definer
set search_path = ''
as $$
  with paid_tickets as materialized (
    select t.id, t.local_created_at, t.total_cents,
      coalesce(t.discount_amount_cents, 0)::bigint as discount_amount_cents,
      t.discount_id, t.discount_name
    from public.tickets t
    where t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
      and t.status = 'paid' and t.local_created_at >= p_period_start and t.local_created_at < p_period_end
      and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
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
      and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
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
      and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
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

create or replace function public.crm_stats_live(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_day_start timestamptz,
  p_day_end timestamptz
)
returns jsonb
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  with day_ticket_totals as (
    select coalesce(sum(t.total_cents), 0) total_cents, count(*) ticket_count
    from public.tickets t
    where t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
      and t.status = 'paid'
      and t.local_created_at >= p_day_start and t.local_created_at < p_day_end
      and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
  ), day_tenders as (
    -- A single left join supplies payment rows OR the legacy fallback.
    -- Test row existence, not method/amount: null and zero are real values.
    select case when p.sale_id is null then s.payment_method else p.method end method,
      case when p.sale_id is null then s.total_cents else p.amount_cents end amount_cents
    from public.sales s
    left join public.sale_payments p on p.tenant_id = p_tenant_id and p.sale_id = s.id
    where s.tenant_id = p_tenant_id and s.venue_id = p_venue_id
      and s.local_created_at >= p_day_start and s.local_created_at < p_day_end
      and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
  ), day_payment_totals as (
    select coalesce(sum(amount_cents) filter (where method = 'cash'), 0) cash_cents,
      coalesce(sum(amount_cents) filter (where method = 'card'), 0) card_cents
    from day_tenders
  ), sessions as materialized (
    -- Open cash sessions intentionally cover every accessible venue in the tenant.
    select cs.id, cs.venue_id, coalesce(v.name, 'Local sin nombre') venue_name,
      coalesce(d.name, 'Caja sin nombre') device_name, cs.opened_at, cs.opening_float_cents
    from public.cash_sessions cs
    left join public.venues v on v.id = cs.venue_id and v.tenant_id = p_tenant_id
    left join public.devices d on d.id = cs.device_id and d.tenant_id = p_tenant_id
    where cs.tenant_id = p_tenant_id and cs.status = 'open'
      and ((select public.crm_can_read_venue_sales(p_tenant_id, null)) or public.user_has_venue_access(cs.tenant_id, cs.venue_id))
  ), session_totals as (
    select active.*, totals.*
    from sessions active
    -- Aggregate per open session before combining sessions. This keeps generic
    -- RPC plans from scanning all tenant sales to build a hash join.
    cross join lateral (
      select coalesce(sum(x.total_cents), 0)::bigint sales_cents, count(*) ticket_count,
        coalesce(sum(x.cash_cents), 0)::bigint cash_cents,
        coalesce(sum(x.card_cents), 0)::bigint card_cents,
        coalesce(sum(x.invitation_cents), 0)::bigint invitation_cents,
        coalesce(sum(x.other_cents), 0)::bigint other_cents
      from (
        -- Count and sum each sale once even when it has several payment rows.
        select s.id, s.total_cents,
          coalesce(sum(tender.amount_cents) filter (where tender.method = 'cash'), 0)::bigint cash_cents,
          coalesce(sum(tender.amount_cents) filter (where tender.method = 'card'), 0)::bigint card_cents,
          coalesce(sum(tender.amount_cents) filter (where tender.method = 'invitation'), 0)::bigint invitation_cents,
          coalesce(sum(tender.amount_cents) filter (
            where tender.method not in ('cash', 'card', 'invitation') or tender.method is null
          ), 0)::bigint other_cents
        from public.sales s
        left join public.sale_payments p on p.tenant_id = p_tenant_id and p.sale_id = s.id
        cross join lateral (
          select case when p.sale_id is null then s.payment_method else p.method end method,
            case when p.sale_id is null then s.total_cents else p.amount_cents end amount_cents
        ) tender
        where s.tenant_id = p_tenant_id and s.cash_session_id = active.id
        group by s.id, s.total_cents
      ) x
    ) totals
  )
  select jsonb_build_object(
    'dayActivity', jsonb_build_object(
      'totalCents', dt.total_cents, 'cashCents', dp.cash_cents,
      'cardCents', dp.card_cents, 'ticketCount', dt.ticket_count
    ),
    'openCashSessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'venueId', venue_id, 'venueName', venue_name, 'deviceName', device_name,
        'openedAt', opened_at, 'openingFloatCents', opening_float_cents,
        'salesCents', sales_cents, 'ticketCount', ticket_count, 'cashCents', cash_cents,
        'cardCents', card_cents, 'invitationCents', invitation_cents, 'otherCents', other_cents
      ) order by opened_at desc)
      from session_totals
    ), '[]'::jsonb)
  )
  from day_ticket_totals dt cross join day_payment_totals dp;
$$;

create or replace function public.pos_product_sales_stats(
  p_tenant_id uuid, p_venue_id uuid, p_after_product_id uuid default null,
  p_limit integer default 500
) returns table(product_id uuid, quantity numeric, total_cents bigint)
language sql stable security definer set search_path = '' as $$
  select l.product_id, sum(coalesce(l.allocated_quantity, l.quantity)), sum(l.line_total_cents)::bigint
  from public.tickets t join public.ticket_lines l on l.ticket_id = t.id and l.tenant_id = t.tenant_id
  where auth.uid() is not null and t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
    and t.status = 'paid' and l.product_id is not null
    and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
    and (p_after_product_id is null or l.product_id > p_after_product_id)
  group by l.product_id order by l.product_id
  limit greatest(1, least(coalesce(p_limit, 500), 500));
$$;

revoke all on function public.crm_stats_period(uuid, uuid, text, date, date, date, timestamptz, timestamptz, text, time without time zone) from public, anon;
grant execute on function public.crm_stats_period(uuid, uuid, text, date, date, date, timestamptz, timestamptz, text, time without time zone) to authenticated, service_role;

revoke all on function public.crm_stats_live(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_stats_live(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;

revoke all on function public.pos_product_sales_stats(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.pos_product_sales_stats(uuid, uuid, uuid, integer) to authenticated, service_role;
