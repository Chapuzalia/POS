-- Soporte fiscal minimo para precios finales con IVA incluido.
-- Los locales existentes parten de IVA general espanol (21 %), configurable
-- desde el CRM. Los productos existentes no se actualizan: tax_rate queda NULL
-- para que sigan heredando el valor del local.

begin;

alter table public.venues
  add column if not exists default_tax_rate numeric(5, 2) not null default 21;

alter table public.venues drop constraint if exists venues_default_tax_rate_check;
alter table public.venues add constraint venues_default_tax_rate_check
  check (default_tax_rate >= 0 and default_tax_rate <= 100);

alter table public.products
  add column if not exists tax_rate numeric(5, 2);

alter table public.products drop constraint if exists products_tax_rate_check;
alter table public.products add constraint products_tax_rate_check
  check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 100));

alter table public.ticket_lines
  add column if not exists tax_rate numeric(5, 2),
  add column if not exists taxable_base_cents integer,
  add column if not exists tax_amount_cents integer;

alter table public.ticket_lines drop constraint if exists ticket_lines_fiscal_snapshot_check;
alter table public.ticket_lines add constraint ticket_lines_fiscal_snapshot_check check (
  (
    tax_rate is null
    and taxable_base_cents is null
    and tax_amount_cents is null
  )
  or
  (
    tax_rate between 0 and 100
    and taxable_base_cents >= 0
    and tax_amount_cents >= 0
    and taxable_base_cents + tax_amount_cents = line_total_cents
  )
);

comment on column public.venues.default_tax_rate is
  'Porcentaje de IVA heredado por los productos cuyo tax_rate es NULL.';
comment on column public.products.tax_rate is
  'Porcentaje de IVA propio; NULL hereda venues.default_tax_rate.';
comment on column public.ticket_lines.tax_rate is
  'Snapshot del porcentaje de IVA efectivo en el momento de persistir la venta.';
comment on column public.ticket_lines.taxable_base_cents is
  'Snapshot de la base imponible de la linea, redondeada al centimo.';
comment on column public.ticket_lines.tax_amount_cents is
  'Snapshot de la cuota de IVA de la linea; base + cuota = line_total_cents.';

create or replace function public.calculate_tax_from_gross(
  p_gross_cents integer,
  p_tax_rate numeric
)
returns table (taxable_base_cents integer, tax_amount_cents integer)
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $$
begin
  if p_gross_cents < 0 then
    raise exception 'El total final no puede ser negativo';
  end if;
  if p_tax_rate < 0 or p_tax_rate > 100 then
    raise exception 'El tipo de IVA debe estar entre 0 y 100';
  end if;

  taxable_base_cents := round(
    p_gross_cents::numeric * 100 / (100 + p_tax_rate)
  )::integer;
  tax_amount_cents := p_gross_cents - taxable_base_cents;
  return next;
end;
$$;

create or replace function public.resolve_effective_tax_rate(
  p_product_id uuid,
  p_tenant_id uuid,
  p_venue_id uuid
)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(p.tax_rate, v.default_tax_rate)
  from public.products p
  join public.venues v
    on v.id = p.venue_id
   and v.tenant_id = p.tenant_id
  where p.id = p_product_id
    and p.tenant_id = p_tenant_id
    and p.venue_id = p_venue_id;
$$;

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
  -- Un cambio ajeno a la identidad fiscal no debe recalcular un ticket cerrado
  -- ni completar artificialmente lineas historicas que carecian de snapshot.
  if tg_op = 'UPDATE'
    and new.tenant_id is not distinct from old.tenant_id
    and new.ticket_id is not distinct from old.ticket_id
    and new.product_id is not distinct from old.product_id
    and new.line_total_cents is not distinct from old.line_total_cents then
    new.tax_rate := old.tax_rate;
    new.taxable_base_cents := old.taxable_base_cents;
    new.tax_amount_cents := old.tax_amount_cents;
    return new;
  end if;

  -- Las FK historicas usan ON DELETE SET NULL. En ese caso se conserva el
  -- snapshot ya guardado en lugar de consultar el IVA actual.
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
  from public.calculate_tax_from_gross(new.line_total_cents, effective_tax_rate);

  -- Se ignora cualquier valor fiscal aportado por el cliente.
  new.tax_rate := effective_tax_rate;
  new.taxable_base_cents := breakdown.taxable_base_cents;
  new.tax_amount_cents := breakdown.tax_amount_cents;
  return new;
end;
$$;

drop trigger if exists set_ticket_line_fiscal_snapshot on public.ticket_lines;
create trigger set_ticket_line_fiscal_snapshot
before insert or update on public.ticket_lines
for each row execute function public.set_ticket_line_fiscal_snapshot();

revoke all on function public.calculate_tax_from_gross(integer, numeric) from public, anon, authenticated;
revoke all on function public.resolve_effective_tax_rate(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_ticket_line_fiscal_snapshot() from public, anon, authenticated;

commit;
