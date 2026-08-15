-- Fixed discounts can apply once to the ticket or once to every eligible line.

alter table public.discounts
  add column if not exists fixed_application text not null default 'ticket';

alter table public.discounts drop constraint if exists discounts_fixed_application_check;
alter table public.discounts add constraint discounts_fixed_application_check check (
  fixed_application in ('ticket', 'line')
  and (type = 'fixed' or fixed_application = 'ticket')
);

create or replace function public.upsert_discount_rule(
  p_discount_id uuid,
  p_venue_id uuid,
  p_input jsonb,
  p_pin text default null
) returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  tenant_id_value uuid;
  rule_id uuid := coalesce(p_discount_id, gen_random_uuid());
  rule_kind_value text := coalesce(p_input ->> 'ruleKind', 'discount');
  scope_value text := coalesce(p_input ->> 'scope', 'general');
  fixed_application_value text := coalesce(p_input ->> 'fixedApplication', 'ticket');
  requires_pin_value boolean := coalesce((p_input ->> 'requiresPin')::boolean, false);
  auto_apply_value boolean := coalesce((p_input ->> 'autoApply')::boolean, false);
  target jsonb;
  product_id_value uuid;
  variant_id_value uuid;
begin
  select v.tenant_id into tenant_id_value
  from public.venues v where v.id = p_venue_id;
  if tenant_id_value is null or not public.user_is_tenant_admin(tenant_id_value) then
    raise exception 'No se puede administrar esta regla' using errcode = '42501';
  end if;
  if nullif(btrim(p_input ->> 'name'), '') is null then raise exception 'El nombre es obligatorio'; end if;
  if p_input ->> 'type' not in ('percentage', 'fixed') then raise exception 'Tipo de descuento no válido'; end if;
  if (p_input ->> 'value')::numeric <= 0
    or (p_input ->> 'type' = 'percentage' and (p_input ->> 'value')::numeric > 100) then
    raise exception 'Valor de descuento no válido';
  end if;
  if p_input ->> 'type' <> 'fixed' then
    fixed_application_value := 'ticket';
  elsif fixed_application_value not in ('ticket', 'line') then
    raise exception 'Aplicación del importe fijo no válida';
  end if;
  if rule_kind_value not in ('discount', 'promotion') or scope_value not in ('general', 'specific') then
    raise exception 'Tipo o ámbito de regla no válido';
  end if;
  if auto_apply_value and (rule_kind_value <> 'promotion' or requires_pin_value) then
    raise exception 'Una promoción automática no puede requerir PIN';
  end if;
  if rule_kind_value = 'promotion' and (
    jsonb_array_length(coalesce(p_input -> 'activeWeekdays', '[]'::jsonb)) = 0
    or nullif(p_input ->> 'startsAt', '') is null
    or nullif(p_input ->> 'endsAt', '') is null
    or (p_input ->> 'startsAt')::time = (p_input ->> 'endsAt')::time
  ) then raise exception 'La programación de la promoción no es válida'; end if;
  if requires_pin_value and p_pin is not null and p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'El PIN debe contener entre 4 y 8 dígitos';
  end if;
  if p_discount_id is not null and not exists (
    select 1 from public.discounts d
    where d.id = p_discount_id and d.tenant_id = tenant_id_value and d.venue_id = p_venue_id
  ) then raise exception 'La regla no existe en este local' using errcode = '42501'; end if;

  insert into public.discounts (
    id, tenant_id, venue_id, name, type, value, rounding_increment_cents,
    fixed_application, color, is_active, rule_kind, scope, requires_pin, active_weekdays,
    starts_at, ends_at, auto_apply, sort_order
  ) values (
    rule_id, tenant_id_value, p_venue_id, btrim(p_input ->> 'name'),
    p_input ->> 'type', (p_input ->> 'value')::numeric,
    nullif(p_input ->> 'roundingIncrementCents', '')::integer,
    fixed_application_value,
    nullif(p_input ->> 'color', ''), coalesce((p_input ->> 'isActive')::boolean, true),
    rule_kind_value, scope_value, requires_pin_value,
    case when rule_kind_value = 'promotion' then
      array(select jsonb_array_elements_text(p_input -> 'activeWeekdays')::smallint)
      else '{}'::smallint[] end,
    case when rule_kind_value = 'promotion' then (p_input ->> 'startsAt')::time else null end,
    case when rule_kind_value = 'promotion' then (p_input ->> 'endsAt')::time else null end,
    case when rule_kind_value = 'promotion' then auto_apply_value else false end,
    0
  )
  on conflict (id) do update set
    name = excluded.name,
    type = excluded.type,
    value = excluded.value,
    rounding_increment_cents = excluded.rounding_increment_cents,
    fixed_application = excluded.fixed_application,
    color = excluded.color,
    is_active = excluded.is_active,
    rule_kind = excluded.rule_kind,
    scope = excluded.scope,
    requires_pin = excluded.requires_pin,
    active_weekdays = excluded.active_weekdays,
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    auto_apply = excluded.auto_apply,
    updated_at = now();

  delete from public.discount_targets where discount_id = rule_id;
  if scope_value = 'specific' then
    if jsonb_typeof(p_input -> 'targets') is distinct from 'array'
      or jsonb_array_length(p_input -> 'targets') = 0 then
      raise exception 'Selecciona al menos un producto o variante';
    end if;
    for target in select value from jsonb_array_elements(p_input -> 'targets')
    loop
      product_id_value := (target ->> 'productId')::uuid;
      variant_id_value := nullif(target ->> 'variantId', '')::uuid;
      if not exists (
        select 1 from public.products p
        where p.id = product_id_value and p.tenant_id = tenant_id_value and p.venue_id = p_venue_id
      ) then raise exception 'Producto no válido para este local'; end if;
      if variant_id_value is not null and not exists (
        select 1 from public.product_variants pv
        where pv.id = variant_id_value and pv.product_id = product_id_value
          and pv.tenant_id = tenant_id_value and pv.venue_id = p_venue_id
      ) then raise exception 'Variante no válida para este producto'; end if;
      insert into public.discount_targets(tenant_id, venue_id, discount_id, product_id, variant_id)
      values (tenant_id_value, p_venue_id, rule_id, product_id_value, variant_id_value)
      on conflict do nothing;
    end loop;
  end if;

  if not requires_pin_value then
    delete from public.discount_secrets where discount_id = rule_id;
  elsif p_pin is not null then
    insert into public.discount_secrets(discount_id, tenant_id, venue_id, pin_hash, updated_at)
    values (rule_id, tenant_id_value, p_venue_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), now())
    on conflict (discount_id) do update
      set pin_hash = excluded.pin_hash, updated_at = now();
  elsif not exists (select 1 from public.discount_secrets where discount_id = rule_id) then
    raise exception 'Configura un PIN de entre 4 y 8 dígitos';
  end if;

  return rule_id;
end;
$$;

create or replace function public.resolve_ticket_discount_for_lines(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_lines jsonb,
  p_discount jsonb default null,
  p_at timestamptz default now()
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  configured public.discounts%rowtype;
  venue_row public.venues%rowtype;
  line_record record;
  selected_id uuid;
  subtotal_cents integer := 0;
  eligible_subtotal integer := 0;
  requested_amount integer := 0;
  amount_cents integer := 0;
  eligible_net integer := 0;
  base_net_total integer := 0;
  remaining_gross integer;
  remaining_net integer;
  remaining_weight integer;
  remaining_adjustment integer;
  line_gross integer;
  line_net integer;
  line_base_net integer;
  line_weight integer;
  line_adjustment integer;
  line_eligible boolean;
  allocations jsonb := '[]'::jsonb;
  targets_snapshot jsonb := '[]'::jsonb;
  snapshot_type text;
  calculation_type text;
  snapshot_name text;
  snapshot_value numeric;
  fixed_value_cents integer;
  fixed_application text := 'ticket';
  rounding_increment integer;
  grant_id uuid;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Las líneas del descuento no son válidas'; end if;
  select v.* into venue_row from public.venues v
  where v.id = p_venue_id and v.tenant_id = p_tenant_id;
  if venue_row.id is null then raise exception 'Local no válido' using errcode = '42501'; end if;

  select d.* into configured
  from public.discounts d
  where d.tenant_id = p_tenant_id and d.venue_id = p_venue_id
    and d.is_active and d.rule_kind = 'promotion' and d.auto_apply
    and public.discount_rule_is_active_at(d, venue_row.timezone, venue_row.day_change_time, p_at)
  order by d.sort_order, d.name, d.id
  limit 1;

  if configured.id is null and p_discount is not null and jsonb_typeof(p_discount) = 'object'
    and nullif(p_discount ->> 'discountId', '') is not null then
    selected_id := (p_discount ->> 'discountId')::uuid;
    select d.* into configured from public.discounts d
    where d.id = selected_id and d.tenant_id = p_tenant_id
      and d.venue_id = p_venue_id and d.is_active;
    if configured.id is null then raise exception 'El descuento configurado ya no está disponible'; end if;
    if configured.rule_kind = 'promotion'
      and not public.discount_rule_is_active_at(configured, venue_row.timezone, venue_row.day_change_time, p_at) then
      raise exception 'La promoción ha dejado de estar disponible';
    end if;
  end if;

  if configured.id is not null then
    if configured.requires_pin then
      delete from public.discount_pin_grants g
      where g.id = (
        select g2.id from public.discount_pin_grants g2
        where g2.user_id = auth.uid() and g2.discount_id = configured.id and g2.expires_at > now()
        order by g2.created_at desc limit 1
      )
      returning g.id into grant_id;
      if grant_id is null then raise exception 'La validación del PIN ha caducado'; end if;
    end if;
    snapshot_type := configured.type;
    calculation_type := configured.type;
    snapshot_name := configured.name;
    snapshot_value := configured.value;
    fixed_value_cents := round(configured.value * 100)::integer;
    fixed_application := configured.fixed_application;
    rounding_increment := configured.rounding_increment_cents;
    select coalesce(jsonb_agg(jsonb_build_object(
      'productId', t.product_id,
      'variantId', t.variant_id
    ) order by t.product_id, t.variant_id), '[]'::jsonb)
    into targets_snapshot from public.discount_targets t where t.discount_id = configured.id;
  elsif p_discount is not null and p_discount ->> 'type' = 'manual' then
    if not venue_row.manual_discount_enabled then raise exception 'El descuento manual no está permitido'; end if;
    snapshot_type := 'manual';
    calculation_type := p_discount ->> 'calculationType';
    snapshot_name := coalesce(nullif(btrim(p_discount ->> 'name'), ''), 'Descuento manual');
    if calculation_type not in ('percentage', 'fixed') then raise exception 'Tipo de descuento no válido'; end if;
    if calculation_type = 'fixed' then
      fixed_value_cents := (p_discount ->> 'value')::integer;
      snapshot_value := fixed_value_cents::numeric / 100;
    else snapshot_value := (p_discount ->> 'value')::numeric; end if;
  end if;

  for line_record in select value, ordinality from jsonb_array_elements(p_lines) with ordinality
  loop
    line_gross := (line_record.value ->> 'grossCents')::integer;
    if line_gross < 0 then raise exception 'Importe de línea no válido'; end if;
    subtotal_cents := subtotal_cents + line_gross;
    line_eligible := configured.id is null
      or configured.scope = 'general'
      or exists (
        select 1 from public.discount_targets t
        where t.discount_id = configured.id
          and t.product_id = nullif(line_record.value ->> 'productId', '')::uuid
          and (t.variant_id is null or t.variant_id = nullif(line_record.value ->> 'variantId', '')::uuid)
      );
    if snapshot_type is not null and line_eligible then
      eligible_subtotal := eligible_subtotal + line_gross;
      if calculation_type = 'fixed' and fixed_application = 'line' then
        requested_amount := requested_amount + least(line_gross, fixed_value_cents);
      end if;
    end if;
  end loop;

  if snapshot_type is not null then
    if calculation_type = 'percentage' then
      if snapshot_value <= 0 or snapshot_value > 100 then raise exception 'Porcentaje no válido'; end if;
      requested_amount := round(eligible_subtotal * snapshot_value / 100)::integer;
    else
      if fixed_value_cents <= 0 then raise exception 'Importe fijo no válido'; end if;
      if fixed_application = 'ticket' then requested_amount := fixed_value_cents; end if;
    end if;
    amount_cents := least(eligible_subtotal, requested_amount);
    eligible_net := eligible_subtotal - amount_cents;
    if rounding_increment is not null then
      eligible_net := least(eligible_subtotal, greatest(0,
        round(eligible_net::numeric / rounding_increment)::integer * rounding_increment));
      amount_cents := eligible_subtotal - eligible_net;
    end if;
  end if;

  remaining_gross := eligible_subtotal;
  remaining_net := eligible_net;
  if calculation_type = 'fixed' and fixed_application = 'line' then
    base_net_total := eligible_subtotal - requested_amount;
    if eligible_net <= base_net_total then
      remaining_weight := base_net_total;
      remaining_adjustment := eligible_net;
    else
      remaining_weight := requested_amount;
      remaining_adjustment := eligible_net - base_net_total;
    end if;
  end if;

  for line_record in select value, ordinality from jsonb_array_elements(p_lines) with ordinality
  loop
    line_gross := (line_record.value ->> 'grossCents')::integer;
    line_eligible := snapshot_type is not null and (
      configured.id is null
      or configured.scope = 'general'
      or exists (
        select 1 from public.discount_targets t
        where t.discount_id = configured.id
          and t.product_id = nullif(line_record.value ->> 'productId', '')::uuid
          and (t.variant_id is null or t.variant_id = nullif(line_record.value ->> 'variantId', '')::uuid)
      )
    );
    if line_eligible and calculation_type = 'fixed' and fixed_application = 'line' then
      line_base_net := greatest(0, line_gross - fixed_value_cents);
      line_weight := case when eligible_net <= base_net_total
        then line_base_net else line_gross - line_base_net end;
      line_adjustment := case when remaining_weight <= 0 then 0
        else round(line_weight::numeric * remaining_adjustment / remaining_weight)::integer end;
      line_net := case when eligible_net <= base_net_total
        then line_adjustment else line_base_net + line_adjustment end;
      remaining_weight := remaining_weight - line_weight;
      remaining_adjustment := remaining_adjustment - line_adjustment;
    elsif line_eligible then
      line_net := case when remaining_gross <= 0 then 0
        else round(line_gross::numeric * remaining_net / remaining_gross)::integer end;
      remaining_gross := remaining_gross - line_gross;
      remaining_net := remaining_net - line_net;
    else line_net := line_gross; end if;
    allocations := allocations || jsonb_build_array(jsonb_build_object(
      'index', line_record.ordinality - 1,
      'lineId', line_record.value ->> 'lineId',
      'eligible', line_eligible,
      'grossCents', line_gross,
      'discountAmountCents', line_gross - line_net,
      'netCents', line_net
    ));
  end loop;

  return jsonb_build_object(
    'discountId', configured.id,
    'name', snapshot_name,
    'type', snapshot_type,
    'calculationType', calculation_type,
    'value', case when calculation_type = 'fixed' then fixed_value_cents else snapshot_value end,
    'storedValue', snapshot_value,
    'fixedApplication', fixed_application,
    'roundingIncrementCents', rounding_increment,
    'ruleKind', coalesce(configured.rule_kind, 'discount'),
    'scope', coalesce(configured.scope, 'general'),
    'targets', targets_snapshot,
    'automatic', coalesce(configured.auto_apply, false),
    'eligibleSubtotalCents', eligible_subtotal,
    'amountCents', amount_cents,
    'totalCents', subtotal_cents - amount_cents,
    'lineAllocations', allocations
  );
end;
$$;

create or replace function public.capture_ticket_discount_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  rule_row public.discounts%rowtype;
  targets jsonb := '[]'::jsonb;
begin
  if new.discount_type is null then
    new.discount_rule_kind := null;
    new.discount_scope := null;
    new.discount_automatic := false;
    new.discount_snapshot := null;
    return new;
  end if;
  if new.discount_id is not null then
    select d.* into rule_row from public.discounts d where d.id = new.discount_id;
    select coalesce(jsonb_agg(jsonb_build_object('productId', t.product_id, 'variantId', t.variant_id)), '[]'::jsonb)
    into targets from public.discount_targets t where t.discount_id = new.discount_id;
    new.discount_rounding_increment_cents := rule_row.rounding_increment_cents;
  end if;
  new.discount_rule_kind := coalesce(rule_row.rule_kind, 'discount');
  new.discount_scope := coalesce(rule_row.scope, 'general');
  new.discount_automatic := coalesce(rule_row.auto_apply, false);
  new.discount_snapshot := jsonb_build_object(
    'discountId', new.discount_id,
    'name', new.discount_name,
    'type', new.discount_type,
    'calculationType', new.discount_value_type,
    'storedValue', new.discount_value,
    'amountCents', new.discount_amount_cents,
    'fixedApplication', coalesce(rule_row.fixed_application, 'ticket'),
    'roundingIncrementCents', new.discount_rounding_increment_cents,
    'ruleKind', new.discount_rule_kind,
    'scope', new.discount_scope,
    'targets', targets,
    'automatic', new.discount_automatic,
    'activeWeekdays', coalesce(to_jsonb(rule_row.active_weekdays), '[]'::jsonb),
    'startsAt', rule_row.starts_at,
    'endsAt', rule_row.ends_at
  );
  return new;
end;
$$;

create or replace function public.allocate_inserted_ticket_line_discounts()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ticket_row public.tickets%rowtype;
  ticket_id_value uuid;
  line_row public.ticket_lines%rowtype;
  eligible_total integer;
  fixed_value_cents integer;
  requested_amount integer;
  base_net_total integer;
  remaining_gross integer;
  remaining_net integer;
  remaining_weight integer;
  remaining_adjustment integer;
  line_base_net integer;
  line_weight integer;
  line_adjustment integer;
  line_net integer;
  eligible boolean;
  fixed_per_line boolean;
begin
  for ticket_id_value in select distinct n.ticket_id from new_ticket_lines n
  loop
    select t.* into ticket_row from public.tickets t where t.id = ticket_id_value;
    if coalesce(ticket_row.discount_amount_cents, 0) = 0 then
      update public.ticket_lines set discount_amount_cents = 0, net_total_cents = line_total_cents
      where ticket_id = ticket_id_value;
      continue;
    end if;
    select coalesce(sum(tl.line_total_cents), 0)::integer into eligible_total
    from public.ticket_lines tl
    where tl.ticket_id = ticket_id_value and (
      coalesce(ticket_row.discount_scope, 'general') = 'general'
      or exists (
        select 1 from jsonb_array_elements(coalesce(ticket_row.discount_snapshot -> 'targets', '[]'::jsonb)) target
        where target ->> 'productId' = tl.product_id::text
          and (target ->> 'variantId' is null or target ->> 'variantId' = tl.variant_id::text)
      )
    );
    if ticket_row.discount_amount_cents > eligible_total then
      raise exception 'El descuento supera el subtotal elegible';
    end if;
    fixed_per_line := ticket_row.discount_value_type = 'fixed'
      and coalesce(ticket_row.discount_snapshot ->> 'fixedApplication', 'ticket') = 'line';
    remaining_gross := eligible_total;
    remaining_net := eligible_total - ticket_row.discount_amount_cents;
    if fixed_per_line then
      fixed_value_cents := round((ticket_row.discount_snapshot ->> 'storedValue')::numeric * 100)::integer;
      select coalesce(sum(least(tl.line_total_cents, fixed_value_cents)), 0)::integer
      into requested_amount
      from public.ticket_lines tl
      where tl.ticket_id = ticket_id_value and (
        coalesce(ticket_row.discount_scope, 'general') = 'general'
        or exists (
          select 1 from jsonb_array_elements(coalesce(ticket_row.discount_snapshot -> 'targets', '[]'::jsonb)) target
          where target ->> 'productId' = tl.product_id::text
            and (target ->> 'variantId' is null or target ->> 'variantId' = tl.variant_id::text)
        )
      );
      base_net_total := eligible_total - requested_amount;
      if remaining_net <= base_net_total then
        remaining_weight := base_net_total;
        remaining_adjustment := remaining_net;
      else
        remaining_weight := requested_amount;
        remaining_adjustment := remaining_net - base_net_total;
      end if;
    end if;
    for line_row in select * from public.ticket_lines where ticket_id = ticket_id_value order by created_at, id
    loop
      eligible := coalesce(ticket_row.discount_scope, 'general') = 'general'
        or exists (
          select 1 from jsonb_array_elements(coalesce(ticket_row.discount_snapshot -> 'targets', '[]'::jsonb)) target
          where target ->> 'productId' = line_row.product_id::text
            and (target ->> 'variantId' is null or target ->> 'variantId' = line_row.variant_id::text)
        );
      if eligible and fixed_per_line then
        line_base_net := greatest(0, line_row.line_total_cents - fixed_value_cents);
        line_weight := case when remaining_net <= base_net_total
          then line_base_net else line_row.line_total_cents - line_base_net end;
        line_adjustment := case when remaining_weight <= 0 then 0
          else round(line_weight::numeric * remaining_adjustment / remaining_weight)::integer end;
        line_net := case when remaining_net <= base_net_total
          then line_adjustment else line_base_net + line_adjustment end;
        remaining_weight := remaining_weight - line_weight;
        remaining_adjustment := remaining_adjustment - line_adjustment;
      elsif eligible then
        line_net := case when remaining_gross <= 0 then 0
          else round(line_row.line_total_cents::numeric * remaining_net / remaining_gross)::integer end;
        remaining_gross := remaining_gross - line_row.line_total_cents;
        remaining_net := remaining_net - line_net;
      else line_net := line_row.line_total_cents; end if;
      update public.ticket_lines
      set net_total_cents = line_net,
          discount_amount_cents = line_total_cents - line_net
      where id = line_row.id;
    end loop;
  end loop;
  return null;
end;
$$;
