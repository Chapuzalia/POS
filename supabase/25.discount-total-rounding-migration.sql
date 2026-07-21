-- Redondeo opcional del total final por descuento configurado.
-- Los importes se expresan en centimos y el servidor sigue siendo la fuente de verdad.

begin;

alter table public.discounts
  add column if not exists rounding_increment_cents integer;

alter table public.discounts
  drop constraint if exists discounts_rounding_increment_cents_check;
alter table public.discounts
  add constraint discounts_rounding_increment_cents_check
  check (rounding_increment_cents is null or rounding_increment_cents in (5, 10, 50, 100));

alter table public.tickets
  add column if not exists discount_rounding_increment_cents integer;

alter table public.tickets
  drop constraint if exists tickets_discount_rounding_increment_cents_check;
alter table public.tickets
  add constraint tickets_discount_rounding_increment_cents_check
  check (
    discount_rounding_increment_cents is null
    or discount_rounding_increment_cents in (5, 10, 50, 100)
  );

create or replace function public.resolve_ticket_discount(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_subtotal_cents integer,
  p_discount jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  configured public.discounts%rowtype;
  snapshot_type text;
  calculation_type text;
  snapshot_name text;
  configured_value numeric(12, 2);
  fixed_value_cents integer;
  amount_cents integer;
  total_cents integer;
  rounding_increment_cents integer;
begin
  if p_subtotal_cents < 0 then
    raise exception 'Subtotal no valido';
  end if;
  if p_discount is null or jsonb_typeof(p_discount) = 'null' then
    return jsonb_build_object('amountCents', 0, 'totalCents', p_subtotal_cents);
  end if;

  if nullif(p_discount ->> 'discountId', '') is not null then
    select d.* into configured
    from public.discounts d
    where d.id = (p_discount ->> 'discountId')::uuid
      and d.tenant_id = p_tenant_id
      and d.venue_id = p_venue_id
      and d.is_active;
    if configured.id is null then
      raise exception 'El descuento no existe, esta inactivo o pertenece a otro local' using errcode = '42501';
    end if;
    snapshot_type := configured.type;
    calculation_type := configured.type;
    snapshot_name := configured.name;
    configured_value := configured.value;
    fixed_value_cents := case when configured.type = 'fixed' then round(configured.value * 100)::integer else null end;
    rounding_increment_cents := configured.rounding_increment_cents;
  else
    if coalesce((select v.manual_discount_enabled from public.venues v
      where v.id = p_venue_id and v.tenant_id = p_tenant_id), false) is false then
      raise exception 'El descuento manual esta deshabilitado' using errcode = '42501';
    end if;
    snapshot_type := 'manual';
    calculation_type := p_discount ->> 'calculationType';
    snapshot_name := 'Descuento manual';
    rounding_increment_cents := null;
    if calculation_type = 'percentage' then
      configured_value := (p_discount ->> 'value')::numeric;
    elsif calculation_type = 'fixed' then
      fixed_value_cents := (p_discount ->> 'value')::integer;
      configured_value := fixed_value_cents::numeric / 100;
    else
      raise exception 'Tipo de descuento manual no valido';
    end if;
  end if;

  if calculation_type = 'percentage' then
    if configured_value <= 0 or configured_value > 100 then
      raise exception 'El porcentaje debe estar entre 0 y 100';
    end if;
    amount_cents := round(p_subtotal_cents * configured_value / 100)::integer;
  else
    if fixed_value_cents is null then
      fixed_value_cents := round(configured_value * 100)::integer;
    end if;
    if fixed_value_cents <= 0 then raise exception 'El importe fijo debe ser mayor que cero'; end if;
    amount_cents := fixed_value_cents;
  end if;

  amount_cents := least(p_subtotal_cents, amount_cents);
  total_cents := p_subtotal_cents - amount_cents;

  if rounding_increment_cents is not null then
    total_cents := least(
      p_subtotal_cents,
      round(total_cents::numeric / rounding_increment_cents)::integer * rounding_increment_cents
    );
    amount_cents := p_subtotal_cents - total_cents;
  end if;

  return jsonb_build_object(
    'discountId', configured.id,
    'name', snapshot_name,
    'type', snapshot_type,
    'calculationType', calculation_type,
    'value', case when calculation_type = 'fixed' then fixed_value_cents else configured_value end,
    'storedValue', configured_value,
    'roundingIncrementCents', rounding_increment_cents,
    'amountCents', amount_cents,
    'totalCents', total_cents
  );
end;
$$;

create or replace function public.set_ticket_discount_rounding_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.discount_id is null or new.discount_type = 'manual' then
    new.discount_rounding_increment_cents := null;
  else
    select d.rounding_increment_cents
      into new.discount_rounding_increment_cents
    from public.discounts d
    where d.id = new.discount_id
      and d.tenant_id = new.tenant_id
      and d.venue_id = new.venue_id;
  end if;
  return new;
end;
$$;

drop trigger if exists set_ticket_discount_rounding_snapshot on public.tickets;
create trigger set_ticket_discount_rounding_snapshot
before insert on public.tickets
for each row execute function public.set_ticket_discount_rounding_snapshot();

revoke all on function public.set_ticket_discount_rounding_snapshot() from public;

create or replace function public.restaurant_equal_split_to_json(p_split public.restaurant_order_equal_splits)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  next_part_number integer := p_split.paid_parts + 1;
  next_subtotal integer := 0;
  next_discount_amount integer := 0;
  next_discount jsonb := null;
  calculation_type text;
  configured_value numeric;
begin
  if p_split.status = 'open' then
    next_subtotal := (p_split.total_cents / p_split.part_count)
      + case when next_part_number <= mod(p_split.total_cents, p_split.part_count) then 1 else 0 end;
  end if;

  if next_subtotal > 0 and p_split.default_discount is not null then
    calculation_type := p_split.default_discount ->> 'calculationType';
    next_discount_amount := (coalesce((p_split.default_discount ->> 'amountCents')::integer, 0) / p_split.part_count)
      + case when next_part_number <= mod(coalesce((p_split.default_discount ->> 'amountCents')::integer, 0), p_split.part_count) then 1 else 0 end;
    next_discount_amount := least(next_subtotal, next_discount_amount);
    if next_discount_amount = 0 then
      next_discount := null;
    elsif calculation_type = 'percentage' then
      configured_value := (p_split.default_discount ->> 'value')::numeric;
      next_discount := jsonb_build_object(
        'discountId', nullif(p_split.default_discount ->> 'discountId', ''),
        'name', p_split.default_discount ->> 'name',
        'type', p_split.default_discount ->> 'type',
        'calculationType', 'percentage',
        'value', configured_value,
        'roundingIncrementCents', nullif(p_split.default_discount ->> 'roundingIncrementCents', '')::integer,
        'color', p_split.default_discount -> 'color'
      );
    elsif calculation_type = 'fixed' then
      if next_discount_amount > 0 then
        next_discount := jsonb_build_object(
          'discountId', nullif(p_split.default_discount ->> 'discountId', ''),
          'name', p_split.default_discount ->> 'name',
          'type', p_split.default_discount ->> 'type',
          'calculationType', 'fixed',
          'value', next_discount_amount,
          'roundingIncrementCents', nullif(p_split.default_discount ->> 'roundingIncrementCents', '')::integer,
          'color', p_split.default_discount -> 'color'
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'id', p_split.id,
    'orderId', p_split.order_id,
    'orderGroupId', p_split.order_group_id,
    'totalCents', p_split.total_cents,
    'partCount', p_split.part_count,
    'paidParts', p_split.paid_parts,
    'paidCents', p_split.paid_cents,
    'remainingParts', p_split.part_count - p_split.paid_parts,
    'remainingCents', p_split.total_cents - p_split.paid_cents,
    'nextPartCents', next_subtotal,
    'nextDefaultDiscount', next_discount,
    'nextDefaultDiscountAmountCents', next_discount_amount,
    'nextDefaultTotalCents', next_subtotal - next_discount_amount,
    'status', p_split.status,
    'revision', p_split.revision,
    'allowPendingService', p_split.allow_pending_service
  );
end;
$$;

commit;

