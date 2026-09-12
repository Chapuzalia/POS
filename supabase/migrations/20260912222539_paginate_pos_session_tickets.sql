-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE, CREATE INDEX WITHOUT CONCURRENTLY
-- migration-safety-reason: Adds a read-only authenticated RPC; regular index builds are required because production Supabase CLI 2.54.11 rejects CONCURRENTLY in its migration pipeline, with lock waits bounded to 5s.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Keep POS ticket history payloads bounded. The page RPC only returns ticket
-- identifiers; the client then fetches nested detail for those twelve rows.

create index if not exists tickets_tenant_session_local_created_idx
  on public.tickets (tenant_id, cash_session_id, local_created_at desc, id desc);

create index if not exists ticket_line_components_ticket_line_id_idx
  on public.ticket_line_components (ticket_line_id);

create index if not exists offline_event_log_sale_ticket_idx
  on public.offline_event_log (
    tenant_id,
    event_kind,
    (payload -> 'ticket' ->> 'id')
  )
  where event_kind = 'sale_created';

create or replace function public.pos_session_ticket_page(
  p_tenant_id uuid,
  p_cash_session_id uuid,
  p_query text default null,
  p_page integer default 1
)
returns table (
  ticket_id uuid,
  ticket_number bigint,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with search_params as (
    select
      public.crm_normalize_search_text(btrim(coalesce(p_query, ''))) as query,
      replace(
        regexp_replace(btrim(coalesce(p_query, '')), '[[:space:]€]', '', 'g'),
        ',',
        '.'
      ) as amount_query
  ),
  ticket_index as (
    select
      t.id,
      t.local_created_at,
      t.total_cents,
      row_number() over (order by t.local_created_at asc, t.id asc)::bigint as ticket_number
    from public.tickets t
    where t.tenant_id = p_tenant_id
      and t.cash_session_id = p_cash_session_id
  ),
  filtered_tickets as (
    select ti.*
    from ticket_index ti
    cross join search_params sp
    where sp.query = ''
      or public.crm_normalize_search_text(ti.id::text) like '%' || sp.query || '%'
      or sp.query = ti.ticket_number::text
      or sp.query = 'ticket ' || ti.ticket_number::text
      or (
        sp.amount_query ~ '^[0-9]+([.][0-9]{1,2})?$'
        and round(sp.amount_query::numeric * 100)::bigint = ti.total_cents
      )
      or exists (
        select 1
        from public.sales matching_sale
        where matching_sale.ticket_id = ti.id
          and public.crm_normalize_search_text(matching_sale.id::text) like '%' || sp.query || '%'
      )
      or exists (
        select 1
        from public.ticket_lines matching_line
        where matching_line.ticket_id = ti.id
          and (
            public.crm_normalize_search_text(matching_line.product_name) like '%' || sp.query || '%'
            or public.crm_normalize_search_text(matching_line.variant_name) like '%' || sp.query || '%'
            or exists (
              select 1
              from public.ticket_line_components matching_component
              where matching_component.ticket_line_id = matching_line.id
                and (
                  public.crm_normalize_search_text(matching_component.product_name_snapshot) like '%' || sp.query || '%'
                  or public.crm_normalize_search_text(matching_component.variant_name_snapshot) like '%' || sp.query || '%'
                )
            )
          )
      )
  ),
  stats as (
    select count(*)::bigint as total_count
    from filtered_tickets
  ),
  paged as (
    select ft.*
    from filtered_tickets ft
    order by ft.local_created_at desc, ft.id desc
    limit 12
    offset ((greatest(coalesce(p_page, 1), 1) - 1) * 12)
  )
  select paged.id, paged.ticket_number, stats.total_count
  from paged
  cross join stats;
$$;

revoke all on function public.pos_session_ticket_page(uuid, uuid, text, integer) from public, anon;
grant execute on function public.pos_session_ticket_page(uuid, uuid, text, integer) to authenticated, service_role;
