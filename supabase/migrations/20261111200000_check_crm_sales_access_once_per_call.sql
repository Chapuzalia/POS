-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Same signatures, results and grants for the CRM dashboard and sales-report read RPCs; only the access check moves from per-row RLS to one equivalent check per call.

-- These read RPCs ran as invoker, so the tickets, ticket_lines and sales RLS
-- policies evaluated several non-inlinable security-definer helpers for every
-- row (and ticket_lines re-checks its ticket, plus the gestor policies). A busy
-- venue's month is hundreds of thousands of rows, which exceeded the API
-- statement timeout. They now run as definer and check access once per call
-- with the same rules as the SELECT policies:
--   tenant admin (owner/manager) or gestor: whole tenant;
--   venue access (assigned cashier): only that venue's rows.
-- Every helper keeps the billing can_operate gate of the restrictive policy.

-- Tenant-wide read (venue null) or read of one venue.
create function public.crm_can_read_venue_sales(p_tenant_id uuid, p_venue_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.user_is_tenant_admin(p_tenant_id)
    or public.user_has_tenant_role(p_tenant_id, array['gestor'::text])
    or (p_venue_id is not null and public.user_has_venue_access(p_tenant_id, p_venue_id));
$$;

revoke all on function public.crm_can_read_venue_sales(uuid, uuid) from public, anon;
grant execute on function public.crm_can_read_venue_sales(uuid, uuid) to authenticated, service_role;

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
security definer
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
    from (
      -- Index-friendly scope; same rows as "p is null or ..." (local_created_at is not null).
      select st.* from public.tickets st
      where st.tenant_id = p_tenant_id and st.venue_id = p_venue_id
        and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
        and st.local_created_at >= coalesce(p_date_from, '-infinity'::timestamptz)
        and st.local_created_at < coalesce(p_date_to, 'infinity'::timestamptz)
      union all
      select st.* from public.tickets st
      where p_venue_id is null and st.tenant_id = p_tenant_id
        and ((select public.crm_can_read_venue_sales(p_tenant_id, null)) or public.user_has_venue_access(st.tenant_id, st.venue_id))
        and st.local_created_at >= coalesce(p_date_from, '-infinity'::timestamptz)
        and st.local_created_at < coalesce(p_date_to, 'infinity'::timestamptz)
    ) t
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

create or replace function public.crm_sales_report_summary(
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
security definer
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
    from (
      -- Index-friendly scope; same rows as "p is null or ..." (local_created_at is not null).
      select st.* from public.tickets st
      where st.tenant_id = p_tenant_id and st.venue_id = p_venue_id
        and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
        and st.local_created_at >= coalesce(p_date_from, '-infinity'::timestamptz)
        and st.local_created_at < coalesce(p_date_to, 'infinity'::timestamptz)
      union all
      select st.* from public.tickets st
      where p_venue_id is null and st.tenant_id = p_tenant_id
        and ((select public.crm_can_read_venue_sales(p_tenant_id, null)) or public.user_has_venue_access(st.tenant_id, st.venue_id))
        and st.local_created_at >= coalesce(p_date_from, '-infinity'::timestamptz)
        and st.local_created_at < coalesce(p_date_to, 'infinity'::timestamptz)
    ) t
    left join lateral (
      select s.payment_method
      from public.sales s
      where s.ticket_id = t.id
        and p_discount_filter in ('with', 'without')
      order by s.created_at desc, s.id desc
      limit 1
    ) sale on true
    where t.tenant_id = p_tenant_id
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

create or replace function public.crm_sales_report_aggregate_page(
  p_tenant_id uuid,
  p_venue_id uuid default null,
  p_view text default 'products',
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_product_query text default null,
  p_category_query text default null,
  p_discount_filter text default 'all',
  p_sort_key text default 'totalCents',
  p_sort_direction text default 'desc',
  p_page integer default 1
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with filtered_tickets as (
    select t.id, t.total_cents, t.local_created_at
    from (
      -- Index-friendly scope; same rows as "p is null or ..." (local_created_at is not null).
      select st.* from public.tickets st
      where st.tenant_id = p_tenant_id and st.venue_id = p_venue_id
        and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
        and st.local_created_at >= coalesce(p_date_from, '-infinity'::timestamptz)
        and st.local_created_at < coalesce(p_date_to, 'infinity'::timestamptz)
      union all
      select st.* from public.tickets st
      where p_venue_id is null and st.tenant_id = p_tenant_id
        and ((select public.crm_can_read_venue_sales(p_tenant_id, null)) or public.user_has_venue_access(st.tenant_id, st.venue_id))
        and st.local_created_at >= coalesce(p_date_from, '-infinity'::timestamptz)
        and st.local_created_at < coalesce(p_date_to, 'infinity'::timestamptz)
    ) t
    left join lateral (
      select s.payment_method
      from public.sales s
      where s.ticket_id = t.id and p_discount_filter in ('with', 'without')
      order by s.created_at desc, s.id desc
      limit 1
    ) sale on true
    where t.tenant_id = p_tenant_id
      and t.status = 'paid'
      and (
        coalesce(p_discount_filter, 'all') = 'all'
        or (p_discount_filter = 'with' and (coalesce(t.discount_amount_cents, 0) > 0 or sale.payment_method = 'invitation'))
        or (p_discount_filter = 'without' and coalesce(t.discount_amount_cents, 0) = 0 and coalesce(sale.payment_method, '') <> 'invitation')
        or (p_discount_filter like 'id:%' and t.discount_id::text = substr(p_discount_filter, 4))
      )
      and exists (
        select 1 from public.ticket_lines tl
        where tl.ticket_id = t.id
          and (coalesce(btrim(p_product_query), '') = '' or public.crm_normalize_search_text(tl.product_name)
            like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%')
          and (coalesce(btrim(p_category_query), '') = '' or public.crm_normalize_search_text(coalesce(tl.category_name_snapshot, 'Sin categoría'))
            like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%')
      )
  ), line_groups as (
    select ft.id as ticket_id, ft.local_created_at,
      array_agg(tl.id order by tl.id) as line_ids,
      public.crm_allocate_net_total_to_lines(array_agg(tl.line_total_cents::bigint order by tl.id), ft.total_cents) as net_cents
    from filtered_tickets ft
    join public.ticket_lines tl on tl.ticket_id = ft.id
    group by ft.id, ft.local_created_at, ft.total_cents
  ), matching_lines as (
    select tl.*, lg.local_created_at, allocation.net_cents,
      coalesce(tl.allocated_quantity, tl.quantity::numeric) as sold_quantity
    from line_groups lg
    cross join lateral unnest(lg.line_ids, lg.net_cents) as allocation(line_id, net_cents)
    join public.ticket_lines tl on tl.id = allocation.line_id
    where (coalesce(btrim(p_product_query), '') = '' or public.crm_normalize_search_text(tl.product_name)
        like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%')
      and (coalesce(btrim(p_category_query), '') = '' or public.crm_normalize_search_text(coalesce(tl.category_name_snapshot, 'Sin categoría'))
        like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%')
  ), entries as (
    select tl.ticket_id, tl.local_created_at, tl.id as line_id, ''::text as detail_id,
      case p_view
        when 'products' then coalesce(tl.product_id::text, 'deleted:' || public.crm_normalize_search_text(tl.product_name))
        when 'variants' then coalesce(tl.variant_id::text, 'deleted:' || public.crm_normalize_search_text(tl.variant_name))
        when 'categories' then coalesce(tl.category_id_snapshot::text, 'uncategorized')
        when 'tabs' then coalesce(tl.catalog_tab_id_snapshot::text, 'sin-pestana')
        when 'formats' then coalesce(tl.sale_format_id::text,
          nullif(public.crm_normalize_search_text(coalesce(tl.sale_format_name_snapshot, tl.variant_name)), ''), 'sin-formato')
      end as group_id,
      case p_view
        when 'products' then tl.product_name
        when 'variants' then coalesce(nullif(tl.variant_name, ''), 'Sin variante')
        when 'categories' then coalesce(tl.category_name_snapshot, 'Sin categoría')
        when 'tabs' then coalesce(nullif(tl.catalog_tab_name_snapshot, ''), 'Sin pestaña histórica')
        when 'formats' then coalesce(nullif(tl.sale_format_name_snapshot, ''), nullif(tl.variant_name, ''), 'Sin formato')
      end as label,
      tl.sold_quantity as quantity, tl.net_cents::numeric as total_cents
    from matching_lines tl
    where p_view in ('products', 'variants', 'categories', 'tabs', 'formats')
    union all
    select tl.ticket_id, tl.local_created_at, tl.id, c.id::text,
      coalesce(c.product_id::text, c.id::text), c.product_name_snapshot,
      c.quantity * tl.sold_quantity, c.price_delta_cents * c.quantity * tl.sold_quantity
    from matching_lines tl
    join public.ticket_line_components c on c.ticket_line_id = tl.id
    where (p_view = 'mixers' and c.component_type = 'mixer')
      or (p_view = 'menu-components' and c.component_type = 'menu_component')
    union all
    select tl.ticket_id, tl.local_created_at, tl.id, modifier.ordinality::text,
      public.crm_normalize_search_text(coalesce(nullif(btrim(modifier.value->>'name'), ''), 'Modificador')),
      coalesce(nullif(btrim(modifier.value->>'name'), ''), 'Modificador'),
      tl.sold_quantity,
      coalesce((modifier.value->>'priceCents')::numeric, (modifier.value->>'price_cents')::numeric, 0) * tl.sold_quantity
    from matching_lines tl
    cross join lateral jsonb_array_elements(coalesce(tl.modifiers, '[]'::jsonb)) with ordinality as modifier(value, ordinality)
    where p_view = 'modifiers'
  ), grouped as (
    select group_id as id,
      (array_agg(label order by local_created_at desc, ticket_id desc, line_id, detail_id))[1] as label,
      sum(quantity) as quantity, count(distinct ticket_id) as ticket_count, sum(total_cents) as total_cents
    from entries
    group by group_id
  ), stats as (
    select count(*) as total_count from grouped
  ), ordered as (
    select g.*, row_number() over (order by
      case when p_sort_key = 'label' and p_sort_direction = 'asc' then public.crm_normalize_search_text(g.label) end asc,
      case when p_sort_key = 'label' and p_sort_direction = 'desc' then public.crm_normalize_search_text(g.label) end desc,
      case when p_sort_key = 'ticketCount' and p_sort_direction = 'asc' then g.ticket_count end asc,
      case when p_sort_key = 'ticketCount' and p_sort_direction = 'desc' then g.ticket_count end desc,
      case when p_sort_key = 'quantity' and p_sort_direction = 'asc' then g.quantity end asc,
      case when p_sort_key = 'quantity' and p_sort_direction = 'desc' then g.quantity end desc,
      case when p_sort_key = 'average' and p_sort_direction = 'asc' then coalesce(g.total_cents / nullif(g.quantity, 0), 0) end asc,
      case when p_sort_key = 'average' and p_sort_direction = 'desc' then coalesce(g.total_cents / nullif(g.quantity, 0), 0) end desc,
      case when p_sort_key = 'totalCents' and p_sort_direction = 'asc' then g.total_cents end asc,
      case when p_sort_key = 'totalCents' and p_sort_direction = 'desc' then g.total_cents end desc,
      g.id asc
    ) as position
    from grouped g
  ), paged as (
    select * from ordered order by position
    limit 12
    offset (select least(greatest(coalesce(p_page, 1) - 1, 0), greatest((total_count - 1) / 12, 0)) * 12 from stats)
  )
  select jsonb_build_object(
    'totalResults', stats.total_count,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'label', label, 'quantity', quantity, 'ticketCount', ticket_count, 'totalCents', total_cents
    ) order by position) from paged), '[]'::jsonb)
  ) from stats;
$$;

create or replace function public.crm_sales_report_filter_suggestions(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_product_query text default null,
  p_category_query text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with period_tickets as (
    select t.id, t.discount_id, t.discount_name
    from public.tickets t
    where t.tenant_id = p_tenant_id
      and t.venue_id = p_venue_id
      and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
      and t.local_created_at >= coalesce(p_date_from, '-infinity'::timestamptz)
      and t.local_created_at < coalesce(p_date_to, 'infinity'::timestamptz)
  )
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(product_name order by product_name)
      from (
        select distinct tl.product_name
        from public.ticket_lines tl
        join period_tickets t on t.id = tl.ticket_id
        where tl.tenant_id = p_tenant_id
          and (coalesce(btrim(p_product_query), '') = ''
            or public.crm_normalize_search_text(tl.product_name)
              like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%')
        order by tl.product_name
        limit 20
      ) products
    ), '[]'::jsonb),
    'categories', coalesce((
      select jsonb_agg(category_name order by category_name)
      from (
        select distinct coalesce(tl.category_name_snapshot, 'Sin categoría') as category_name
        from public.ticket_lines tl
        join period_tickets t on t.id = tl.ticket_id
        where tl.tenant_id = p_tenant_id
          and (coalesce(btrim(p_category_query), '') = ''
            or public.crm_normalize_search_text(coalesce(tl.category_name_snapshot, 'Sin categoría'))
              like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%')
        order by category_name
        limit 20
      ) categories
    ), '[]'::jsonb),
    'discounts', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)
      from (
        select distinct t.discount_id as id, t.discount_name as name
        from period_tickets t
        where t.discount_id is not null and t.discount_name is not null
        order by name, id
      ) discounts
    ), '[]'::jsonb)
  );
$$;

create or replace function public.crm_dashboard_period_summary(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
)
returns jsonb
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  with paid_tickets as materialized (
    select t.id, t.total_cents
    from public.tickets t
    where t.tenant_id = p_tenant_id and t.venue_id = p_venue_id
      and (select public.crm_can_read_venue_sales(p_tenant_id, p_venue_id))
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

revoke all on function public.crm_sales_report_ticket_page(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, integer, integer, boolean) from public, anon;
revoke all on function public.crm_sales_report_summary(uuid, uuid, timestamptz, timestamptz, text, text, text) from public, anon;
revoke all on function public.crm_sales_report_aggregate_page(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, text, integer) from public, anon;
revoke all on function public.crm_sales_report_filter_suggestions(uuid, uuid, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function public.crm_dashboard_period_summary(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.crm_sales_report_ticket_page(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, integer, integer, boolean) to authenticated, service_role;
grant execute on function public.crm_sales_report_summary(uuid, uuid, timestamptz, timestamptz, text, text, text) to authenticated, service_role;
grant execute on function public.crm_sales_report_aggregate_page(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, text, integer) to authenticated, service_role;
grant execute on function public.crm_sales_report_filter_suggestions(uuid, uuid, timestamptz, timestamptz, text, text) to authenticated, service_role;
grant execute on function public.crm_dashboard_period_summary(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
