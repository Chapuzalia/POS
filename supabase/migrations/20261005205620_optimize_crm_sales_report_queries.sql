-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Preserve the legacy page signature, results, grants and fiscal allocation; restrict only the new summary RPC to authenticated roles.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Only resolve quantities/payment methods before pagination when required by
-- the sort or invitation-aware discount filter. Date pages hydrate 12 rows in
-- the existing tenant-scoped client query; legacy summary callers still work.
create or replace function public.crm_sales_report_ticket_page(
  p_tenant_id uuid,
  p_venue_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_product_query text default null,
  p_category_query text default null,
  p_discount_filter text default 'all',
  p_sort_key text default 'createdAt',
  p_sort_direction text default 'desc',
  p_page integer default 1,
  p_page_size integer default 12,
  p_include_summary boolean default true
)
returns table (
  ticket_id uuid,
  total_count bigint,
  paid_ticket_count bigint,
  summary_subtotal_cents bigint,
  summary_tax_amount_cents bigint,
  summary_total_cents bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ticket_index as (
    select
      t.id,
      t.local_created_at,
      t.status,
      t.total_cents,
      coalesce(t.discount_amount_cents, 0) as discount_amount_cents,
      t.discount_id,
      coalesce(sale.payment_method, '') as payment_method,
      coalesce(line_totals.quantity, 0) as quantity
    from public.tickets t
    left join lateral (
      select s.payment_method
      from public.sales s
      where s.ticket_id = t.id
        and (p_sort_key = 'paymentMethod' or p_discount_filter in ('with', 'without'))
      order by s.created_at desc, s.id desc
      limit 1
    ) sale on true
    left join lateral (
      select sum(coalesce(tl.allocated_quantity, tl.quantity::numeric)) as quantity
      from public.ticket_lines tl
      where tl.ticket_id = t.id
        and p_sort_key = 'quantity'
    ) line_totals on true
    where t.tenant_id = p_tenant_id
      and (p_venue_id is null or t.venue_id = p_venue_id)
      and (p_date_from is null or t.local_created_at >= p_date_from)
      and (p_date_to is null or t.local_created_at < p_date_to)
  ),
  filtered_tickets as (
    select ti.*
    from ticket_index ti
    where (
      coalesce(p_discount_filter, 'all') = 'all'
      or (p_discount_filter = 'with' and (ti.discount_amount_cents > 0 or ti.payment_method = 'invitation'))
      or (p_discount_filter = 'without' and ti.discount_amount_cents = 0 and ti.payment_method <> 'invitation')
      or (p_discount_filter like 'id:%' and ti.discount_id::text = substr(p_discount_filter, 4))
    )
      and (
        (coalesce(btrim(p_product_query), '') = '' and coalesce(btrim(p_category_query), '') = '')
        or exists (
          select 1
          from public.ticket_lines matching_line
          where matching_line.ticket_id = ti.id
            and (
              coalesce(btrim(p_product_query), '') = ''
              or public.crm_normalize_search_text(matching_line.product_name)
                like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%'
            )
            and (
              coalesce(btrim(p_category_query), '') = ''
              or public.crm_normalize_search_text(coalesce(matching_line.category_name_snapshot, 'Sin categoría'))
                like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%'
            )
        )
      )
  ),
  stats as (
    select count(*)::bigint as total_count,
      count(*) filter (where status = 'paid')::bigint as paid_ticket_count
    from filtered_tickets
  ),
  paid_line_groups as (
    select
      ft.id as ticket_id,
      ft.total_cents,
      array_agg(tl.id order by tl.id) as line_ids,
      array_agg(tl.line_total_cents::bigint order by tl.id) as gross_line_cents
    from filtered_tickets ft
    join public.ticket_lines tl on tl.ticket_id = ft.id
    where ft.status = 'paid'
      and coalesce(p_include_summary, true)
    group by ft.id, ft.total_cents
  ),
  allocated_lines as (
    select
      line_group.ticket_id,
      allocation.line_id,
      allocation.net_cents
    from paid_line_groups line_group
    cross join lateral unnest(
      line_group.line_ids,
      public.crm_allocate_net_total_to_lines(line_group.gross_line_cents, line_group.total_cents)
    ) as allocation(line_id, net_cents)
  ),
  matching_summary_lines as (
    select al.net_cents, tl.*
    from allocated_lines al
    join public.ticket_lines tl on tl.id = al.line_id
    where (
      coalesce(btrim(p_product_query), '') = ''
      or public.crm_normalize_search_text(tl.product_name)
        like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%'
    )
      and (
        coalesce(btrim(p_category_query), '') = ''
        or public.crm_normalize_search_text(coalesce(tl.category_name_snapshot, 'Sin categoría'))
          like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%'
      )
  ),
  summary as (
    select
      coalesce(sum(case
        when tax_rate is null or taxable_base_cents is null or tax_amount_cents is null then net_cents
        when net_cents = line_total_cents then taxable_base_cents
        else round((net_cents::numeric * 100) / (100 + tax_rate))::bigint
      end), 0)::bigint as subtotal_cents,
      coalesce(sum(case
        when tax_rate is null or taxable_base_cents is null or tax_amount_cents is null then 0
        when net_cents = line_total_cents then tax_amount_cents
        else net_cents - round((net_cents::numeric * 100) / (100 + tax_rate))::bigint
      end), 0)::bigint as tax_amount_cents,
      coalesce(sum(net_cents), 0)::bigint as total_cents
    from matching_summary_lines
  ),
  paged as (
    select ft.*
    from filtered_tickets ft
    order by
      case when p_sort_direction = 'asc' and p_sort_key = 'ticketId' then ft.id::text end asc,
      case when p_sort_direction = 'desc' and p_sort_key = 'ticketId' then ft.id::text end desc,
      case when p_sort_direction = 'asc' and p_sort_key = 'createdAt' then ft.local_created_at end asc,
      case when p_sort_direction = 'desc' and p_sort_key = 'createdAt' then ft.local_created_at end desc,
      case when p_sort_direction = 'asc' and p_sort_key = 'quantity' then ft.quantity end asc,
      case when p_sort_direction = 'desc' and p_sort_key = 'quantity' then ft.quantity end desc,
      case when p_sort_direction = 'asc' and p_sort_key = 'paymentMethod' then ft.payment_method end asc,
      case when p_sort_direction = 'desc' and p_sort_key = 'paymentMethod' then ft.payment_method end desc,
      case when p_sort_direction = 'asc' and p_sort_key = 'status' then ft.status end asc,
      case when p_sort_direction = 'desc' and p_sort_key = 'status' then ft.status end desc,
      case when p_sort_direction = 'asc' and p_sort_key = 'totalCents' then ft.total_cents end asc,
      case when p_sort_direction = 'desc' and p_sort_key = 'totalCents' then ft.total_cents end desc,
      ft.local_created_at desc,
      ft.id desc
    limit least(greatest(coalesce(p_page_size, 12), 1), 1000)
    offset ((greatest(coalesce(p_page, 1), 1) - 1) * least(greatest(coalesce(p_page_size, 12), 1), 1000))
  )
  select
    paged.id,
    stats.total_count,
    stats.paid_ticket_count,
    summary.subtotal_cents,
    summary.tax_amount_cents,
    summary.total_cents
  from paged
  cross join stats
  cross join summary;
$$;

-- Summary keeps the exact historical line allocation and tax rounding, but
-- never calculates table quantities, sorts tickets or prepares a page.
create function public.crm_sales_report_summary(
  p_tenant_id uuid,
  p_venue_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_product_query text default null,
  p_category_query text default null,
  p_discount_filter text default 'all'
)
returns table (
  paid_ticket_count bigint,
  summary_subtotal_cents bigint,
  summary_tax_amount_cents bigint,
  summary_total_cents bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ticket_index as (
    select
      t.id,
      t.local_created_at,
      t.status,
      t.total_cents,
      coalesce(t.discount_amount_cents, 0) as discount_amount_cents,
      t.discount_id,
      coalesce(sale.payment_method, '') as payment_method
    from public.tickets t
    left join lateral (
      select s.payment_method
      from public.sales s
      where s.ticket_id = t.id
        and p_discount_filter in ('with', 'without')
      order by s.created_at desc, s.id desc
      limit 1
    ) sale on true
    where t.tenant_id = p_tenant_id
      and (p_venue_id is null or t.venue_id = p_venue_id)
      and (p_date_from is null or t.local_created_at >= p_date_from)
      and (p_date_to is null or t.local_created_at < p_date_to)
  ),
  filtered_tickets as (
    select ti.*
    from ticket_index ti
    where (
      coalesce(p_discount_filter, 'all') = 'all'
      or (p_discount_filter = 'with' and (ti.discount_amount_cents > 0 or ti.payment_method = 'invitation'))
      or (p_discount_filter = 'without' and ti.discount_amount_cents = 0 and ti.payment_method <> 'invitation')
      or (p_discount_filter like 'id:%' and ti.discount_id::text = substr(p_discount_filter, 4))
    )
      and (
        (coalesce(btrim(p_product_query), '') = '' and coalesce(btrim(p_category_query), '') = '')
        or exists (
          select 1
          from public.ticket_lines matching_line
          where matching_line.ticket_id = ti.id
            and (
              coalesce(btrim(p_product_query), '') = ''
              or public.crm_normalize_search_text(matching_line.product_name)
                like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%'
            )
            and (
              coalesce(btrim(p_category_query), '') = ''
              or public.crm_normalize_search_text(coalesce(matching_line.category_name_snapshot, 'Sin categoría'))
                like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%'
            )
        )
      )
  ),
  stats as (
    select count(*) filter (where status = 'paid')::bigint as paid_ticket_count
    from filtered_tickets
  ),
  paid_line_groups as (
    select
      ft.id as ticket_id,
      ft.total_cents,
      array_agg(tl.id order by tl.id) as line_ids,
      array_agg(tl.line_total_cents::bigint order by tl.id) as gross_line_cents
    from filtered_tickets ft
    join public.ticket_lines tl on tl.ticket_id = ft.id
    where ft.status = 'paid'
    group by ft.id, ft.total_cents
  ),
  allocated_lines as (
    select
      line_group.ticket_id,
      allocation.line_id,
      allocation.net_cents
    from paid_line_groups line_group
    cross join lateral unnest(
      line_group.line_ids,
      public.crm_allocate_net_total_to_lines(line_group.gross_line_cents, line_group.total_cents)
    ) as allocation(line_id, net_cents)
  ),
  matching_summary_lines as (
    select al.net_cents, tl.*
    from allocated_lines al
    join public.ticket_lines tl on tl.id = al.line_id
    where (
      coalesce(btrim(p_product_query), '') = ''
      or public.crm_normalize_search_text(tl.product_name)
        like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%'
    )
      and (
        coalesce(btrim(p_category_query), '') = ''
        or public.crm_normalize_search_text(coalesce(tl.category_name_snapshot, 'Sin categoría'))
          like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%'
      )
  ),
  summary as (
    select
      coalesce(sum(case
        when tax_rate is null or taxable_base_cents is null or tax_amount_cents is null then net_cents
        when net_cents = line_total_cents then taxable_base_cents
        else round((net_cents::numeric * 100) / (100 + tax_rate))::bigint
      end), 0)::bigint as subtotal_cents,
      coalesce(sum(case
        when tax_rate is null or taxable_base_cents is null or tax_amount_cents is null then 0
        when net_cents = line_total_cents then tax_amount_cents
        else net_cents - round((net_cents::numeric * 100) / (100 + tax_rate))::bigint
      end), 0)::bigint as tax_amount_cents,
      coalesce(sum(net_cents), 0)::bigint as total_cents
    from matching_summary_lines
  )
  select stats.paid_ticket_count, summary.subtotal_cents,
    summary.tax_amount_cents, summary.total_cents
  from stats cross join summary;
$$;

revoke all on function public.crm_sales_report_summary(uuid, uuid, timestamptz, timestamptz, text, text, text) from public;
grant execute on function public.crm_sales_report_summary(uuid, uuid, timestamptz, timestamptz, text, text, text) to authenticated, service_role;
