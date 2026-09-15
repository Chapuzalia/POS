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
  with ticket_lines as (
    select
      t.id as ticket_id,
      tl.tax_rate,
      sum(coalesce(tl.taxable_base_cents, tl.net_total_cents, tl.line_total_cents))::bigint as base_cents,
      sum(coalesce(tl.tax_amount_cents, 0))::bigint as tax_cents
    from public.tickets t
    join public.ticket_lines tl on tl.ticket_id = t.id
    where t.tenant_id = p_tenant_id
      and t.venue_id = p_venue_id
      and t.local_created_at >= p_from
      and t.local_created_at < p_to
    group by t.id, tl.tax_rate
  ),
  tax_totals as (
    select ticket_id,
      coalesce(jsonb_agg(jsonb_build_object(
        'rate', tax_rate,
        'baseCents', base_cents,
        'taxCents', tax_cents
      ) order by tax_rate nulls last), '[]'::jsonb) as tax_breakdown
    from ticket_lines
    group by ticket_id
  ),
  payment_totals as (
    select s.ticket_id,
      coalesce(sum(sp.amount_cents) filter (where lower(sp.method) = 'cash'), 0)::bigint as cash_cents,
      coalesce(sum(sp.amount_cents) filter (where lower(sp.method) = 'card'), 0)::bigint as card_cents,
      coalesce(sum(sp.amount_cents) filter (where lower(sp.method) not in ('cash', 'card')), 0)::bigint as other_cents
    from public.sales s
    left join public.sale_payments sp on sp.sale_id = s.id
    where s.tenant_id = p_tenant_id
      and s.venue_id = p_venue_id
    group by s.ticket_id
  )
  select
    t.id,
    t.ticket_number,
    t.local_created_at,
    v.name,
    cr.name,
    t.status,
    t.total_cents::bigint,
    coalesce(t.discount_amount_cents, 0)::bigint,
    coalesce(pt.cash_cents, 0),
    coalesce(pt.card_cents, 0),
    coalesce(pt.other_cents, 0),
    coalesce(tt.tax_breakdown, '[]'::jsonb),
    coalesce(t.is_invoice, false),
    t.invoice_series,
    t.invoice_number,
    fi.invoice_type,
    coalesce(t.customer_snapshot ->> 'legalName', t.customer_snapshot ->> 'name'),
    coalesce(t.customer_snapshot ->> 'taxId', t.customer_snapshot ->> 'nif'),
    0::bigint
  from public.tickets t
  join public.venues v on v.id = t.venue_id
  join public.cash_registers cr on cr.id = t.cash_register_id
  left join tax_totals tt on tt.ticket_id = t.id
  left join payment_totals pt on pt.ticket_id = t.id
  left join lateral (
    select invoice.invoice_type
    from public.fiscal_invoices invoice
    where invoice.tenant_id = t.tenant_id and invoice.ticket_id = t.id
    order by invoice.created_at desc, invoice.id desc
    limit 1
  ) fi on true
  where t.tenant_id = p_tenant_id
    and t.venue_id = p_venue_id
    and t.local_created_at >= p_from
    and t.local_created_at < p_to
  order by t.local_created_at asc, t.ticket_number asc, t.id asc;
end;
$$;

revoke all on function public.get_accounting_ticket_export(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_accounting_ticket_export(uuid, uuid, timestamptz, timestamptz) to authenticated, service_role;
