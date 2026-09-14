set lock_timeout = '5s';
set statement_timeout = '5min';

create or replace function public.get_accounting_ticket_export(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_from timestamptz,
  p_to timestamptz
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
  if auth.uid() is null then
    raise exception 'Se requiere un usuario autenticado' using errcode = '42501';
  end if;
  if not public.user_has_tenant_access(p_tenant_id)
    or not exists (
      select 1
      from public.venues venue
      where venue.id = p_venue_id
        and venue.tenant_id = p_tenant_id
        and venue.is_active = true
    )
    or not (
      public.user_is_tenant_admin(p_tenant_id)
      or public.user_has_tenant_role(p_tenant_id, array['owner'::text])
      or (
        public.user_has_tenant_role(p_tenant_id, array['manager'::text])
        and exists (
          select 1
          from public.manager_venue_assignments assignment
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
  with line_tax_totals as (
    select
      ticket_rows.id as ticket_id,
      line_rows.tax_rate,
      sum(coalesce(line_rows.taxable_base_cents, line_rows.net_total_cents, line_rows.line_total_cents))::bigint as base_cents,
      sum(coalesce(line_rows.tax_amount_cents, 0))::bigint as tax_cents
    from public.tickets ticket_rows
    join public.ticket_lines line_rows on line_rows.ticket_id = ticket_rows.id
    where ticket_rows.tenant_id = p_tenant_id
      and ticket_rows.venue_id = p_venue_id
      and ticket_rows.local_created_at >= p_from
      and ticket_rows.local_created_at < p_to
    group by ticket_rows.id, line_rows.tax_rate
  ),
  ticket_tax_totals as (
    select tax_rows.ticket_id as grouped_ticket_id,
      coalesce(jsonb_agg(jsonb_build_object(
        'rate', tax_rows.tax_rate,
        'baseCents', tax_rows.base_cents,
        'taxCents', tax_rows.tax_cents
      ) order by tax_rows.tax_rate nulls last), '[]'::jsonb) as tax_breakdown
    from line_tax_totals tax_rows
    group by tax_rows.ticket_id
  ),
  ticket_payment_totals as (
    select sale_rows.ticket_id as grouped_ticket_id,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) = 'cash'), 0)::bigint as cash_cents,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) = 'card'), 0)::bigint as card_cents,
      coalesce(sum(payment_rows.amount_cents) filter (where lower(payment_rows.method) not in ('cash', 'card')), 0)::bigint as other_cents
    from public.sales sale_rows
    left join public.sale_payments payment_rows on payment_rows.sale_id = sale_rows.id
    where sale_rows.tenant_id = p_tenant_id
      and sale_rows.venue_id = p_venue_id
    group by sale_rows.ticket_id
  )
  select
    ticket_rows.id,
    ticket_rows.ticket_number,
    ticket_rows.local_created_at,
    venue_rows.name,
    register_rows.name,
    ticket_rows.status,
    ticket_rows.total_cents::bigint,
    coalesce(ticket_rows.discount_amount_cents, 0)::bigint,
    coalesce(payment_totals.cash_cents, 0),
    coalesce(payment_totals.card_cents, 0),
    coalesce(payment_totals.other_cents, 0),
    coalesce(tax_totals.tax_breakdown, '[]'::jsonb),
    coalesce(ticket_rows.is_invoice, false),
    ticket_rows.invoice_series,
    ticket_rows.invoice_number,
    invoice_rows.invoice_type,
    coalesce(ticket_rows.customer_snapshot ->> 'legalName', ticket_rows.customer_snapshot ->> 'name'),
    coalesce(ticket_rows.customer_snapshot ->> 'taxId', ticket_rows.customer_snapshot ->> 'nif'),
    0::bigint
  from public.tickets ticket_rows
  join public.venues venue_rows on venue_rows.id = ticket_rows.venue_id
  join public.cash_registers register_rows on register_rows.id = ticket_rows.cash_register_id
  left join ticket_tax_totals tax_totals on tax_totals.grouped_ticket_id = ticket_rows.id
  left join ticket_payment_totals payment_totals on payment_totals.grouped_ticket_id = ticket_rows.id
  left join lateral (
    select fiscal_rows.invoice_type
    from public.fiscal_invoices fiscal_rows
    where fiscal_rows.tenant_id = ticket_rows.tenant_id
      and fiscal_rows.ticket_id = ticket_rows.id
    order by fiscal_rows.created_at desc, fiscal_rows.id desc
    limit 1
  ) invoice_rows on true
  where ticket_rows.tenant_id = p_tenant_id
    and ticket_rows.venue_id = p_venue_id
    and ticket_rows.local_created_at >= p_from
    and ticket_rows.local_created_at < p_to
  order by ticket_rows.local_created_at asc, ticket_rows.ticket_number asc, ticket_rows.id asc;
end;
$$;

revoke all on function public.get_accounting_ticket_export(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_accounting_ticket_export(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
