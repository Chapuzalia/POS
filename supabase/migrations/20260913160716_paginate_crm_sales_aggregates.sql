-- migration-safety: expand
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Restrict only the new read-only RPC to authenticated roles; existing APIs and RLS remain unchanged.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Filter and aggregate in Postgres, then return at most twelve groups. A group
-- includes every matching paid sale, not just the first page of ticket lines.
create function public.crm_sales_report_aggregate_page(
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
security invoker
set search_path = ''
as $$
  with filtered_tickets as (
    select t.id, t.total_cents, t.local_created_at
    from public.tickets t
    left join lateral (
      select s.payment_method
      from public.sales s
      where s.ticket_id = t.id and p_discount_filter in ('with', 'without')
      order by s.created_at desc, s.id desc
      limit 1
    ) sale on true
    where t.tenant_id = p_tenant_id
      and (p_venue_id is null or t.venue_id = p_venue_id)
      and t.status = 'paid'
      and (p_date_from is null or t.local_created_at >= p_date_from)
      and (p_date_to is null or t.local_created_at < p_date_to)
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

revoke all on function public.crm_sales_report_aggregate_page(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, text, integer) from public;
grant execute on function public.crm_sales_report_aggregate_page(uuid, uuid, text, timestamptz, timestamptz, text, text, text, text, text, integer) to authenticated, service_role;
