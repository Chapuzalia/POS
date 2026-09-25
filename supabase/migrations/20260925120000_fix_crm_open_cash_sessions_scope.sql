-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserves the existing crm_stats_live signature and tenant-scoped read contract while returning open cash sessions across the tenant's venues.
set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.crm_stats_live(p_tenant_id uuid, p_venue_id uuid, p_day_start timestamptz, p_day_end timestamptz)
returns jsonb language sql stable parallel safe security invoker set search_path = '' as $$
  with day_tickets as (select id, total_cents from public.tickets where tenant_id = p_tenant_id and venue_id = p_venue_id and status = 'paid' and local_created_at >= p_day_start and local_created_at < p_day_end),
  day_sales as (select payment_method, total_cents from public.sales where tenant_id = p_tenant_id and venue_id = p_venue_id and local_created_at >= p_day_start and local_created_at < p_day_end),
  sessions as (select cs.id, cs.venue_id, coalesce(v.name, 'Local sin nombre') venue_name, coalesce(d.name, 'Caja sin nombre') device_name, cs.opened_at, cs.opening_float_cents from public.cash_sessions cs left join public.venues v on v.id = cs.venue_id and v.tenant_id = p_tenant_id left join public.devices d on d.id = cs.device_id and d.tenant_id = p_tenant_id where cs.tenant_id = p_tenant_id and cs.status = 'open'),
  session_totals as (select s.*, coalesce(sum(x.total_cents), 0)::bigint sales_cents, count(x.*) ticket_count, coalesce(sum(x.total_cents) filter (where x.payment_method = 'cash'), 0)::bigint cash_cents, coalesce(sum(x.total_cents) filter (where x.payment_method = 'card'), 0)::bigint card_cents, coalesce(sum(x.total_cents) filter (where x.payment_method = 'invitation'), 0)::bigint invitation_cents, coalesce(sum(x.total_cents) filter (where x.payment_method not in ('cash', 'card', 'invitation') or x.payment_method is null), 0)::bigint other_cents from sessions s left join public.sales x on x.cash_session_id = s.id and x.tenant_id = p_tenant_id group by s.id, s.venue_id, s.venue_name, s.device_name, s.opened_at, s.opening_float_cents)
  select jsonb_build_object('dayActivity', jsonb_build_object('totalCents', coalesce((select sum(total_cents) from day_tickets), 0), 'cashCents', coalesce((select sum(total_cents) from day_sales where payment_method = 'cash'), 0), 'cardCents', coalesce((select sum(total_cents) from day_sales where payment_method = 'card'), 0), 'ticketCount', (select count(*) from day_tickets)), 'openCashSessions', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'venueId', venue_id, 'venueName', venue_name, 'deviceName', device_name, 'openedAt', opened_at, 'openingFloatCents', opening_float_cents, 'salesCents', sales_cents, 'ticketCount', ticket_count, 'cashCents', cash_cents, 'cardCents', card_cents, 'invitationCents', invitation_cents, 'otherCents', other_cents) order by opened_at desc) from session_totals), '[]'::jsonb));
$$;

revoke all on function public.crm_stats_live(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_stats_live(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
