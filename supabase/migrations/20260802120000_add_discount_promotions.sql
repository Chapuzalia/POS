-- Unified discounts and scheduled promotions.
-- Existing rows remain manual, general discounts through safe defaults.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

alter table public.discounts
  add column if not exists rule_kind text not null default 'discount',
  add column if not exists scope text not null default 'general',
  add column if not exists requires_pin boolean not null default false,
  add column if not exists active_weekdays smallint[] not null default '{}'::smallint[],
  add column if not exists starts_at time without time zone,
  add column if not exists ends_at time without time zone,
  add column if not exists auto_apply boolean not null default false;

alter table public.discounts drop constraint if exists discounts_rule_kind_check;
alter table public.discounts add constraint discounts_rule_kind_check
  check (rule_kind in ('discount', 'promotion'));
alter table public.discounts drop constraint if exists discounts_scope_check;
alter table public.discounts add constraint discounts_scope_check
  check (scope in ('general', 'specific'));
alter table public.discounts drop constraint if exists discounts_schedule_check;
alter table public.discounts add constraint discounts_schedule_check check (
  (rule_kind = 'discount'
    and cardinality(active_weekdays) = 0
    and starts_at is null
    and ends_at is null
    and auto_apply = false)
  or
  (rule_kind = 'promotion'
    and cardinality(active_weekdays) > 0
    and active_weekdays <@ array[1,2,3,4,5,6,7]::smallint[]
    and starts_at is not null
    and ends_at is not null
    and starts_at <> ends_at)
);
alter table public.discounts drop constraint if exists discounts_auto_pin_check;
alter table public.discounts add constraint discounts_auto_pin_check
  check (not (auto_apply and requires_pin));

create table if not exists public.discount_targets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  discount_id uuid not null references public.discounts(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists discount_targets_whole_product_unique
  on public.discount_targets(discount_id, product_id) where variant_id is null;
create unique index if not exists discount_targets_variant_unique
  on public.discount_targets(discount_id, product_id, variant_id) where variant_id is not null;
create index if not exists discount_targets_rule_idx
  on public.discount_targets(tenant_id, venue_id, discount_id);
create index if not exists discounts_active_rules_idx
  on public.discounts(tenant_id, venue_id, is_active, rule_kind, auto_apply, sort_order);

create table if not exists public.discount_secrets (
  discount_id uuid primary key references public.discounts(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  pin_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.discount_pin_grants (
  id uuid primary key default gen_random_uuid(),
  discount_id uuid not null references public.discounts(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists discount_pin_grants_lookup_idx
  on public.discount_pin_grants(user_id, discount_id, expires_at);

alter table public.discount_targets enable row level security;
alter table public.discount_secrets enable row level security;
alter table public.discount_pin_grants enable row level security;

drop policy if exists discount_targets_select on public.discount_targets;
create policy discount_targets_select on public.discount_targets for select to authenticated
  using (
    public.user_is_tenant_admin(tenant_id)
    or (
      public.user_has_venue_access(tenant_id, venue_id)
      and exists (
        select 1 from public.discounts d
        where d.id = discount_id and d.is_active
      )
    )
  );
drop policy if exists discount_targets_owner_manage on public.discount_targets;
create policy discount_targets_owner_manage on public.discount_targets for all to authenticated
  using (public.user_is_tenant_admin(tenant_id))
  with check (public.user_is_tenant_admin(tenant_id));

-- Intentionally no direct policies for secrets or one-use validation grants.
revoke all on public.discount_secrets from anon, authenticated;
revoke all on public.discount_pin_grants from anon, authenticated;

alter table public.tickets
  add column if not exists discount_rule_kind text,
  add column if not exists discount_scope text,
  add column if not exists discount_automatic boolean not null default false,
  add column if not exists discount_snapshot jsonb;

alter table public.ticket_lines
  add column if not exists discount_amount_cents integer not null default 0,
  add column if not exists net_total_cents integer;

update public.ticket_lines
set net_total_cents = line_total_cents - discount_amount_cents
where net_total_cents is null;

alter table public.ticket_lines alter column net_total_cents set not null;
alter table public.ticket_lines drop constraint if exists ticket_lines_discount_amount_cents_check;
alter table public.ticket_lines add constraint ticket_lines_discount_amount_cents_check
  check (discount_amount_cents >= 0 and discount_amount_cents <= line_total_cents);
alter table public.ticket_lines drop constraint if exists ticket_lines_net_total_cents_check;
alter table public.ticket_lines add constraint ticket_lines_net_total_cents_check
  check (net_total_cents = line_total_cents - discount_amount_cents);
alter table public.ticket_lines drop constraint if exists ticket_lines_fiscal_snapshot_check;
alter table public.ticket_lines add constraint ticket_lines_fiscal_snapshot_check check (
  (tax_rate is null and taxable_base_cents is null and tax_amount_cents is null)
  or (
    tax_rate between 0 and 100
    and taxable_base_cents >= 0
    and tax_amount_cents >= 0
    and taxable_base_cents + tax_amount_cents = net_total_cents
  )
);

create or replace function public.discount_rule_is_active_at(
  p_rule public.discounts,
  p_timezone text,
  p_day_change_time time without time zone,
  p_at timestamptz default now()
) returns boolean
language plpgsql stable
set search_path = ''
as $$
declare
  local_at timestamp without time zone;
  local_time time without time zone;
  local_date date;
  operational_date date;
  schedule_date date;
  overnight boolean;
begin
  if p_rule.rule_kind <> 'promotion' then return true; end if;
  if cardinality(p_rule.active_weekdays) = 0
    or p_rule.starts_at is null or p_rule.ends_at is null
    or p_rule.starts_at = p_rule.ends_at then return false; end if;

  local_at := p_at at time zone p_timezone;
  local_time := local_at::time;
  local_date := local_at::date;
  operational_date := local_date - case
    when local_time < coalesce(p_day_change_time, '00:00'::time) then 1 else 0 end;
  overnight := p_rule.ends_at < p_rule.starts_at;

  if overnight then
    if not (local_time >= p_rule.starts_at or local_time < p_rule.ends_at) then return false; end if;
    schedule_date := case
      when local_time < p_rule.ends_at then least(operational_date, local_date - 1)
      else operational_date
    end;
  else
    if not (local_time >= p_rule.starts_at and local_time < p_rule.ends_at) then return false; end if;
    schedule_date := operational_date;
  end if;

  return extract(isodow from schedule_date)::smallint = any(p_rule.active_weekdays);
end;
$$;

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
    color, is_active, rule_kind, scope, requires_pin, active_weekdays,
    starts_at, ends_at, auto_apply, sort_order
  ) values (
    rule_id, tenant_id_value, p_venue_id, btrim(p_input ->> 'name'),
    p_input ->> 'type', (p_input ->> 'value')::numeric,
    nullif(p_input ->> 'roundingIncrementCents', '')::integer,
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

create or replace function public.validate_discount_pin(
  p_discount_id uuid,
  p_pin text
) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  rule_row public.discounts%rowtype;
  secret_hash text;
begin
  if p_pin !~ '^[0-9]{4,8}$' then return false; end if;
  select d.* into rule_row from public.discounts d where d.id = p_discount_id;
  if rule_row.id is null or not rule_row.is_active or not rule_row.requires_pin
    or not public.user_has_venue_access(rule_row.tenant_id, rule_row.venue_id) then return false; end if;
  select s.pin_hash into secret_hash from public.discount_secrets s where s.discount_id = p_discount_id;
  if secret_hash is null or extensions.crypt(p_pin, secret_hash) <> secret_hash then return false; end if;

  delete from public.discount_pin_grants
  where user_id = auth.uid() and discount_id = p_discount_id;
  insert into public.discount_pin_grants(discount_id, tenant_id, venue_id, user_id, expires_at)
  values (p_discount_id, rule_row.tenant_id, rule_row.venue_id, auth.uid(), now() + interval '5 minutes');
  return true;
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
  remaining_gross integer;
  remaining_net integer;
  line_gross integer;
  line_net integer;
  line_eligible boolean;
  allocations jsonb := '[]'::jsonb;
  targets_snapshot jsonb := '[]'::jsonb;
  snapshot_type text;
  calculation_type text;
  snapshot_name text;
  snapshot_value numeric;
  fixed_value_cents integer;
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
    if snapshot_type is not null and line_eligible then eligible_subtotal := eligible_subtotal + line_gross; end if;
  end loop;

  if snapshot_type is not null then
    if calculation_type = 'percentage' then
      if snapshot_value <= 0 or snapshot_value > 100 then raise exception 'Porcentaje no válido'; end if;
      requested_amount := round(eligible_subtotal * snapshot_value / 100)::integer;
    else
      if fixed_value_cents <= 0 then raise exception 'Importe fijo no válido'; end if;
      requested_amount := fixed_value_cents;
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
    if line_eligible then
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

-- Backward-compatible entry point. New clients include authoritative line inputs.
create or replace function public.resolve_ticket_discount(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_subtotal_cents integer,
  p_discount jsonb default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  lines jsonb;
  result jsonb;
begin
  lines := case
    when jsonb_typeof(p_discount -> 'calculationLines') = 'array'
      then p_discount -> 'calculationLines'
    else jsonb_build_array(jsonb_build_object(
      'productId', null, 'variantId', null, 'grossCents', p_subtotal_cents
    ))
  end;
  result := public.resolve_ticket_discount_for_lines(
    p_tenant_id, p_venue_id, lines, p_discount, now()
  );
  if (result ->> 'totalCents')::integer + (result ->> 'amountCents')::integer <> p_subtotal_cents then
    raise exception 'Las líneas del descuento no coinciden con el subtotal';
  end if;
  return result;
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

drop trigger if exists capture_ticket_discount_snapshot_trigger on public.tickets;
create trigger capture_ticket_discount_snapshot_trigger
before insert on public.tickets
for each row execute function public.capture_ticket_discount_snapshot();

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
  remaining_gross integer;
  remaining_net integer;
  line_net integer;
  eligible boolean;
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
    remaining_gross := eligible_total;
    remaining_net := eligible_total - ticket_row.discount_amount_cents;
    for line_row in select * from public.ticket_lines where ticket_id = ticket_id_value order by created_at, id
    loop
      eligible := coalesce(ticket_row.discount_scope, 'general') = 'general'
        or exists (
          select 1 from jsonb_array_elements(coalesce(ticket_row.discount_snapshot -> 'targets', '[]'::jsonb)) target
          where target ->> 'productId' = line_row.product_id::text
            and (target ->> 'variantId' is null or target ->> 'variantId' = line_row.variant_id::text)
        );
      if eligible then
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

drop trigger if exists allocate_inserted_ticket_line_discounts_trigger on public.ticket_lines;
create trigger allocate_inserted_ticket_line_discounts_trigger
after insert on public.ticket_lines
referencing new table as new_ticket_lines
for each statement execute function public.allocate_inserted_ticket_line_discounts();

revoke all on function public.upsert_discount_rule(uuid, uuid, jsonb, text) from public;
grant execute on function public.upsert_discount_rule(uuid, uuid, jsonb, text) to authenticated;
revoke all on function public.validate_discount_pin(uuid, text) from public;
grant execute on function public.validate_discount_pin(uuid, text) to authenticated;
revoke all on function public.resolve_ticket_discount_for_lines(uuid, uuid, jsonb, jsonb, timestamptz) from public;
grant execute on function public.resolve_ticket_discount_for_lines(uuid, uuid, jsonb, jsonb, timestamptz) to authenticated;

