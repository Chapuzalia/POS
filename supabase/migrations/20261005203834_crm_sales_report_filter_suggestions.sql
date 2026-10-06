-- migration-safety: expand
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Restrict the new read-only suggestions RPC to authenticated roles; preserve the legacy RPC and RLS.
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Keep the legacy all-history suggestions RPC for N-1 clients.
create function public.crm_sales_report_filter_suggestions(
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
security invoker
set search_path = ''
as $$
  with period_tickets as (
    select t.id, t.discount_id, t.discount_name
    from public.tickets t
    where t.tenant_id = p_tenant_id
      and t.venue_id = p_venue_id
      and (p_date_from is null or t.local_created_at >= p_date_from)
      and (p_date_to is null or t.local_created_at < p_date_to)
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

revoke all on function public.crm_sales_report_filter_suggestions(uuid, uuid, timestamptz, timestamptz, text, text) from public;
grant execute on function public.crm_sales_report_filter_suggestions(uuid, uuid, timestamptz, timestamptz, text, text) to authenticated, service_role;
