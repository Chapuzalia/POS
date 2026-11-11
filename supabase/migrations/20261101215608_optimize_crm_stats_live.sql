-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve the live CRM RPC signature, JSON, invoker RLS and grants while eliminating duplicate payment lookups and indexing sales by cash session.

-- Day lookups already use sales_venue_local_created_idx. Open sessions need
-- their own access path so closed-session history is not read on every refresh.
create index if not exists sales_tenant_cash_session_stats_idx
  on public.sales (tenant_id, cash_session_id);

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
security invoker
set search_path = ''
as $$
  with day_ticket_totals as (
    select coalesce(sum(t.total_cents), 0) total_cents, count(*) ticket_count
    from public.tickets t
    where t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
      and t.status = 'paid'
      and t.local_created_at >= p_day_start and t.local_created_at < p_day_end
  ), day_tenders as (
    -- A single left join supplies payment rows OR the legacy fallback.
    -- Test row existence, not method/amount: null and zero are real values.
    select case when p.sale_id is null then s.payment_method else p.method end method,
      case when p.sale_id is null then s.total_cents else p.amount_cents end amount_cents
    from public.sales s
    left join public.sale_payments p on p.tenant_id = p_tenant_id and p.sale_id = s.id
    where s.tenant_id = p_tenant_id and s.venue_id = p_venue_id
      and s.local_created_at >= p_day_start and s.local_created_at < p_day_end
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
