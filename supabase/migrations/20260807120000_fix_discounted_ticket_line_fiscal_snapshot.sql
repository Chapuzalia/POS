-- Ticket-level discounts are allocated after inserting all ticket lines. The
-- resulting net total is the gross amount that includes VAT for fiscal
-- purposes, so changing it must also refresh the immutable tax snapshot.

create or replace function public.set_ticket_line_fiscal_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ticket_venue_id uuid;
  effective_tax_rate numeric;
  breakdown record;
begin
  -- Preserve historical snapshots only when none of their fiscal inputs has
  -- changed. Discount allocation changes net_total_cents and must recalculate.
  if tg_op = 'UPDATE'
    and new.tenant_id is not distinct from old.tenant_id
    and new.ticket_id is not distinct from old.ticket_id
    and new.product_id is not distinct from old.product_id
    and new.line_total_cents is not distinct from old.line_total_cents
    and new.net_total_cents is not distinct from old.net_total_cents then
    new.tax_rate := old.tax_rate;
    new.taxable_base_cents := old.taxable_base_cents;
    new.tax_amount_cents := old.tax_amount_cents;
    return new;
  end if;

  -- Historical catalogue references may be null. Preserve their existing
  -- snapshot instead of resolving today's tax configuration.
  if new.product_id is null then
    if tg_op = 'UPDATE' then
      new.tax_rate := old.tax_rate;
      new.taxable_base_cents := old.taxable_base_cents;
      new.tax_amount_cents := old.tax_amount_cents;
      return new;
    end if;
    raise exception 'Una linea de venta nueva requiere un producto para resolver el IVA';
  end if;

  select t.venue_id
  into ticket_venue_id
  from public.tickets t
  where t.id = new.ticket_id
    and t.tenant_id = new.tenant_id;

  if ticket_venue_id is null then
    raise exception 'El ticket de la linea no pertenece al negocio indicado';
  end if;

  effective_tax_rate := public.resolve_effective_tax_rate(
    new.product_id,
    new.tenant_id,
    ticket_venue_id
  );

  if effective_tax_rate is null then
    raise exception 'No se puede resolver el IVA del producto para el local del ticket';
  end if;

  select *
  into breakdown
  from public.calculate_tax_from_gross(new.net_total_cents, effective_tax_rate);

  -- Ignore any fiscal values supplied by the client.
  new.tax_rate := effective_tax_rate;
  new.taxable_base_cents := breakdown.taxable_base_cents;
  new.tax_amount_cents := breakdown.tax_amount_cents;
  return new;
end;
$$;

