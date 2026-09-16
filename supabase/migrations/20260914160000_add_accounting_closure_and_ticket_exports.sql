-- migration-safety: expand
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Adds accounting export RPCs and preserves authenticated access while retaining existing contracts.
set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.get_accounting_closures_export(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns table (
  cash_session_id uuid,
  opened_at timestamptz,
  closed_at timestamptz,
  venue_name text,
  cash_register_name text,
  shift_label text,
  first_ticket_number bigint,
  last_ticket_number bigint,
  ticket_count bigint,
  tax_breakdown jsonb,
  total_sales_cents bigint,
  cash_cents bigint,
  card_cents bigint,
  other_payment_cents bigint,
  refunds_cents bigint,
  discounts_cents bigint,
  tips_cents bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not public.user_has_tenant_access(p_tenant_id)
    or not exists (
      select 1 from public.venues venue
      where venue.id = p_venue_id and venue.tenant_id = p_tenant_id and venue.is_active
    )
    or not (
      public.user_is_tenant_admin(p_tenant_id)
      or public.user_has_tenant_role(p_tenant_id, array['owner'::text])
      or (
        public.user_has_tenant_role(p_tenant_id, array['manager'::text])
        and exists (
          select 1 from public.manager_venue_assignments assignment
          where assignment.tenant_id = p_tenant_id
            and assignment.manager_user_id = auth.uid()
            and assignment.venue_id = p_venue_id
        )
      )
    ) then
    raise exception 'El usuario no tiene acceso al negocio o local' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'El rango temporal no es válido';
  end if;

  return query
  with selected_sessions as (
    select session_rows.id, session_rows.opened_at, session_rows.closed_at,
      session_rows.cash_register_id, session_rows.print_snapshot
    from public.cash_sessions session_rows
    where session_rows.tenant_id = p_tenant_id
      and session_rows.venue_id = p_venue_id
      and session_rows.status = 'closed'
      and session_rows.closed_at >= p_from
      and session_rows.closed_at < p_to
  ),
  session_tickets as (
    select session_rows.id as cash_session_id,
      min(ticket_rows.ticket_number) as first_ticket_number,
      max(ticket_rows.ticket_number) as last_ticket_number,
      count(ticket_rows.id)::bigint as ticket_count
    from selected_sessions session_rows
    left join public.tickets ticket_rows on ticket_rows.cash_session_id = session_rows.id
    group by session_rows.id
  ),
  line_taxes as (
    select ticket_rows.cash_session_id, line_rows.tax_rate,
      sum(coalesce(line_rows.taxable_base_cents, line_rows.net_total_cents, line_rows.line_total_cents))::bigint as base_cents,
      sum(coalesce(line_rows.tax_amount_cents, 0))::bigint as tax_cents
    from selected_sessions session_rows
    join public.tickets ticket_rows on ticket_rows.cash_session_id = session_rows.id and ticket_rows.status = 'paid'
    join public.ticket_lines line_rows on line_rows.ticket_id = ticket_rows.id
    group by ticket_rows.cash_session_id, line_rows.tax_rate
  ),
  session_taxes as (
    select cash_session_id,
      jsonb_agg(jsonb_build_object('rate', tax_rate, 'baseCents', base_cents, 'taxCents', tax_cents) order by tax_rate nulls last) as tax_breakdown
    from line_taxes
    group by cash_session_id
  ),
  session_payments as (
    select ticket_rows.cash_session_id,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) = 'cash'), 0)::bigint as cash_cents,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) = 'card'), 0)::bigint as card_cents,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) not in ('cash', 'card')), 0)::bigint as other_payment_cents,
      coalesce(sum(ticket_rows.discount_amount_cents), 0)::bigint as discounts_cents,
      coalesce(sum(ticket_rows.total_cents), 0)::bigint as total_sales_cents
    from selected_sessions session_rows
    join public.tickets ticket_rows on ticket_rows.cash_session_id = session_rows.id and ticket_rows.status = 'paid'
    left join public.sales sale_rows on sale_rows.ticket_id = ticket_rows.id
    left join public.sale_payments payment_rows on payment_rows.sale_id = sale_rows.id
    group by ticket_rows.cash_session_id
  )
  select session_rows.id, session_rows.opened_at, session_rows.closed_at,
    venue_rows.name, register_rows.name,
    coalesce(session_rows.print_snapshot ->> 'shiftLabel', ''),
    ticket_stats.first_ticket_number, ticket_stats.last_ticket_number, coalesce(ticket_stats.ticket_count, 0),
    coalesce(session_taxes.tax_breakdown, '[]'::jsonb),
    coalesce(session_payments.total_sales_cents, 0),
    coalesce(session_payments.cash_cents, 0), coalesce(session_payments.card_cents, 0),
    coalesce(session_payments.other_payment_cents, 0), 0::bigint,
    coalesce(session_payments.discounts_cents, 0), 0::bigint
  from selected_sessions session_rows
  join public.venues venue_rows on venue_rows.id = p_venue_id
  join public.cash_registers register_rows on register_rows.id = session_rows.cash_register_id
  left join session_tickets ticket_stats on ticket_stats.cash_session_id = session_rows.id
  left join session_taxes on session_taxes.cash_session_id = session_rows.id
  left join session_payments on session_payments.cash_session_id = session_rows.id
  order by session_rows.closed_at asc, session_rows.id asc;
end;
$$;

create or replace function public.get_accounting_tickets_export(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_product_query text default null,
  p_category_query text default null,
  p_discount_filter text default 'all'
) returns table (
  ticket_id uuid,
  ticket_number bigint,
  local_created_at timestamptz,
  venue_name text,
  cash_register_name text,
  status text,
  total_cents bigint,
  discount_cents bigint,
  payment_cash_cents bigint,
  payment_card_cents bigint,
  payment_other_cents bigint,
  tax_breakdown jsonb,
  is_invoice boolean,
  invoice_series text,
  invoice_number text,
  invoice_type text,
  customer_name text,
  customer_tax_id text,
  tip_cents bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or not public.user_has_tenant_access(p_tenant_id)
    or not exists (
      select 1 from public.venues venue
      where venue.id = p_venue_id and venue.tenant_id = p_tenant_id and venue.is_active
    )
    or not (
      public.user_is_tenant_admin(p_tenant_id)
      or public.user_has_tenant_role(p_tenant_id, array['owner'::text])
      or (
        public.user_has_tenant_role(p_tenant_id, array['manager'::text])
        and exists (
          select 1 from public.manager_venue_assignments assignment
          where assignment.tenant_id = p_tenant_id and assignment.manager_user_id = auth.uid() and assignment.venue_id = p_venue_id
        )
      )
    ) then
    raise exception 'El usuario no tiene acceso al negocio o local' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'El rango temporal no es válido';
  end if;

  return query
  with selected_tickets as (
    select ticket_rows.*
    from public.tickets ticket_rows
    where ticket_rows.tenant_id = p_tenant_id
      and ticket_rows.venue_id = p_venue_id
      and ticket_rows.local_created_at >= p_from
      and ticket_rows.local_created_at < p_to
      and (coalesce(p_discount_filter, 'all') = 'all'
        or (p_discount_filter = 'with' and coalesce(ticket_rows.discount_amount_cents, 0) > 0)
        or (p_discount_filter = 'without' and coalesce(ticket_rows.discount_amount_cents, 0) = 0)
        or (p_discount_filter like 'id:%' and ticket_rows.discount_id::text = substr(p_discount_filter, 4)))
      and (coalesce(btrim(p_product_query), '') = '' or exists (
        select 1 from public.ticket_lines line_rows
        where line_rows.ticket_id = ticket_rows.id
          and public.crm_normalize_search_text(line_rows.product_name) like '%' || public.crm_normalize_search_text(btrim(p_product_query)) || '%'
      ))
      and (coalesce(btrim(p_category_query), '') = '' or exists (
        select 1 from public.ticket_lines line_rows
        where line_rows.ticket_id = ticket_rows.id
          and public.crm_normalize_search_text(coalesce(line_rows.category_name_snapshot, 'Sin categoría')) like '%' || public.crm_normalize_search_text(btrim(p_category_query)) || '%'
      ))
  ),
  line_taxes as (
    select ticket_rows.id as ticket_id, line_rows.tax_rate,
      sum(coalesce(line_rows.taxable_base_cents, line_rows.net_total_cents, line_rows.line_total_cents))::bigint as base_cents,
      sum(coalesce(line_rows.tax_amount_cents, 0))::bigint as tax_cents
    from selected_tickets ticket_rows
    join public.ticket_lines line_rows on line_rows.ticket_id = ticket_rows.id
    group by ticket_rows.id, line_rows.tax_rate
  ),
  ticket_taxes as (
    select tax_rows.ticket_id,
      jsonb_agg(jsonb_build_object('rate', tax_rows.tax_rate, 'baseCents', tax_rows.base_cents, 'taxCents', tax_rows.tax_cents) order by tax_rows.tax_rate nulls last) as tax_breakdown
    from line_taxes tax_rows group by tax_rows.ticket_id
  ),
  ticket_payments as (
    select sale_rows.ticket_id,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) = 'cash'), 0)::bigint as cash_cents,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) = 'card'), 0)::bigint as card_cents,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) not in ('cash', 'card')), 0)::bigint as other_cents
    from public.sales sale_rows
    left join public.sale_payments payment_rows on payment_rows.sale_id = sale_rows.id
    where sale_rows.tenant_id = p_tenant_id and sale_rows.venue_id = p_venue_id
    group by sale_rows.ticket_id
  )
  select ticket_rows.id, ticket_rows.ticket_number, ticket_rows.local_created_at, venue_rows.name, register_rows.name,
    ticket_rows.status, ticket_rows.total_cents::bigint, coalesce(ticket_rows.discount_amount_cents, 0)::bigint,
    coalesce(ticket_payments.cash_cents, 0), coalesce(ticket_payments.card_cents, 0), coalesce(ticket_payments.other_cents, 0),
    coalesce(ticket_taxes.tax_breakdown, '[]'::jsonb), coalesce(ticket_rows.is_invoice, false), ticket_rows.invoice_series, ticket_rows.invoice_number,
    invoice_rows.invoice_type, coalesce(ticket_rows.customer_snapshot ->> 'legalName', ticket_rows.customer_snapshot ->> 'name'),
    coalesce(ticket_rows.customer_snapshot ->> 'taxId', ticket_rows.customer_snapshot ->> 'nif'), 0::bigint
  from selected_tickets ticket_rows
  join public.venues venue_rows on venue_rows.id = ticket_rows.venue_id
  join public.cash_registers register_rows on register_rows.id = ticket_rows.cash_register_id
  left join ticket_taxes on ticket_taxes.ticket_id = ticket_rows.id
  left join ticket_payments on ticket_payments.ticket_id = ticket_rows.id
  left join lateral (
    select fiscal_rows.invoice_type from public.fiscal_invoices fiscal_rows
    where fiscal_rows.tenant_id = ticket_rows.tenant_id and fiscal_rows.ticket_id = ticket_rows.id
    order by fiscal_rows.created_at desc, fiscal_rows.id desc limit 1
  ) invoice_rows on true
  order by ticket_rows.local_created_at asc, ticket_rows.ticket_number asc, ticket_rows.id asc;
end;
$$;

revoke all on function public.get_accounting_closures_export(uuid, uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.get_accounting_tickets_export(uuid, uuid, timestamptz, timestamptz, text, text, text) from public, anon;
grant execute on function public.get_accounting_closures_export(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.get_accounting_tickets_export(uuid, uuid, timestamptz, timestamptz, text, text, text) to authenticated, service_role;
