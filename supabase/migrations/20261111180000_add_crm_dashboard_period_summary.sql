-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New authenticated-only read RPC for the CRM dashboard; crm_stats_period and crm_stats_live stay unchanged for N-1 clients.

-- The CRM dashboard only shows the period's ticket totals and top products.
-- crm_stats_period also builds combinations, modifiers, mixers, hourly,
-- discount and payment breakdowns, which exceeds the API statement timeout
-- for high-volume venues. This narrow RPC serves the dashboard; the stats
-- page keeps using crm_stats_period unchanged.
create function public.crm_dashboard_period_summary(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns jsonb
language sql
stable
parallel safe
security invoker
set search_path = ''
as $$
  with paid_tickets as materialized (
    select t.id, t.total_cents
    from public.tickets t
    where t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
      and t.status = 'paid' and t.local_created_at >= p_period_start and t.local_created_at < p_period_end
  ), ticket_totals as (
    select count(*) ticket_count, coalesce(sum(total_cents), 0)::bigint total_cents
    from paid_tickets
  ), products as (
    -- Same product identity, label, quantity and ordering as crm_stats_period.topProducts.
    select coalesce(nullif(btrim(tl.product_name), ''), 'Producto sin nombre') label,
      sum(coalesce(tl.allocated_quantity, tl.quantity::numeric)) quantity,
      sum(tl.line_total_cents)::bigint total_cents
    from public.ticket_lines tl join paid_tickets pt on pt.id = tl.ticket_id
    where tl.tenant_id = p_tenant_id
    group by coalesce(tl.product_id::text, 'deleted:' || lower(btrim(tl.product_name))), 1
  )
  select jsonb_build_object(
    'averageTicketCents', coalesce(round(tt.total_cents::numeric / nullif(tt.ticket_count, 0)), 0),
    'monthSalesCents', tt.total_cents,
    'monthTicketCount', tt.ticket_count,
    'topProducts', coalesce((
      select jsonb_agg(jsonb_build_object('productName', label, 'quantity', quantity, 'totalCents', total_cents) order by quantity desc, total_cents desc, label)
      from (select * from products order by quantity desc, total_cents desc, label limit 8) x
    ), '[]'::jsonb)
  ) from ticket_totals tt;
$$;

revoke all on function public.crm_dashboard_period_summary(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_dashboard_period_summary(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
