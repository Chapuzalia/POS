-- Inventory is an auxiliary side effect of a sale. A malformed recipe or an
-- inconsistent stock row must not roll back a valid payment. Keep the whole
-- line consumption in one PL/pgSQL subtransaction, record the diagnostic and
-- let the ticket insert finish.

create table if not exists public.inventory_consumption_failures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  venue_id uuid,
  ticket_line_id uuid not null,
  product_id uuid,
  error_code text not null,
  error_message text not null,
  created_at timestamptz not null default now(),
  constraint inventory_consumption_failures_error_code_check
    check (btrim(error_code) <> '' and char_length(error_code) <= 20),
  constraint inventory_consumption_failures_error_message_check
    check (btrim(error_message) <> '' and char_length(error_message) <= 1000)
);

create index if not exists inventory_consumption_failures_venue_created_idx
  on public.inventory_consumption_failures (tenant_id, venue_id, created_at desc);

alter table public.inventory_consumption_failures enable row level security;

drop policy if exists inventory_consumption_failures_select
  on public.inventory_consumption_failures;
create policy inventory_consumption_failures_select
on public.inventory_consumption_failures
for select
to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or (
    venue_id is not null
    and public.user_has_venue_access(tenant_id, venue_id)
  )
);

revoke all on table public.inventory_consumption_failures from public, anon;
grant select on table public.inventory_consumption_failures to authenticated;

create or replace function public.consume_ticket_line_inventory()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_venue_id uuid;
  v_device_id uuid;
  v_inventory_enabled boolean;
  v_sold_quantity numeric(18, 9);
  v_component record;
  v_modifier jsonb;
  v_mixer_product_id uuid;
  v_mixer_variant_id uuid;
  v_error_code text;
  v_error_message text;
begin
  select t.venue_id, t.device_id, v.inventory_enabled
  into v_venue_id, v_device_id, v_inventory_enabled
  from public.tickets t
  join public.venues v
    on v.id = t.venue_id
   and v.tenant_id = t.tenant_id
  where t.id = new.ticket_id
    and t.tenant_id = new.tenant_id;

  if v_venue_id is null then
    raise exception 'INVENTORY_TICKET_SCOPE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not v_inventory_enabled then
    return new;
  end if;

  v_sold_quantity := coalesce(new.allocated_quantity, new.quantity::numeric);

  perform public.consume_inventory_product(
    new.id,
    new.tenant_id,
    v_venue_id,
    v_device_id,
    new.product_id,
    new.variant_id,
    v_sold_quantity,
    'product'
  );

  for v_component in
    select c.component_type, c.product_id, c.variant_id, c.quantity
    from public.ticket_line_components c
    where c.ticket_line_id = new.id
      and c.tenant_id = new.tenant_id
      and c.product_id is not null
  loop
    perform public.consume_inventory_product(
      new.id,
      new.tenant_id,
      v_venue_id,
      v_device_id,
      v_component.product_id,
      v_component.variant_id,
      v_sold_quantity * v_component.quantity,
      case
        when v_component.component_type = 'mixer' then 'mixer'
        else 'menu_component'
      end
    );
  end loop;

  if not exists (
    select 1
    from public.ticket_line_components c
    where c.ticket_line_id = new.id
      and c.component_type = 'mixer'
  ) then
    for v_modifier in
      select value
      from jsonb_array_elements(coalesce(new.modifiers, '[]'::jsonb))
      where value ->> 'id' ~* '^mixer:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    loop
      v_mixer_product_id := substring(v_modifier ->> 'id' from 7)::uuid;
      select pv.id into v_mixer_variant_id
      from public.product_variants pv
      where pv.product_id = v_mixer_product_id
        and pv.tenant_id = new.tenant_id
        and pv.venue_id = v_venue_id
        and pv.is_active = true
      order by pv.is_default desc, pv.sort_order, pv.id
      limit 1;

      perform public.consume_inventory_product(
        new.id,
        new.tenant_id,
        v_venue_id,
        v_device_id,
        v_mixer_product_id,
        v_mixer_variant_id,
        v_sold_quantity,
        'mixer'
      );
    end loop;
  end if;

  return new;
exception
  when others then
    get stacked diagnostics
      v_error_code = returned_sqlstate,
      v_error_message = message_text;

    -- Entering the exception handler rolls back every stock change performed
    -- for this ticket line, so a failed recipe can never leave partial stock.
    begin
      insert into public.inventory_consumption_failures (
        tenant_id,
        venue_id,
        ticket_line_id,
        product_id,
        error_code,
        error_message
      ) values (
        new.tenant_id,
        v_venue_id,
        new.id,
        new.product_id,
        coalesce(nullif(v_error_code, ''), 'UNKNOWN'),
        left(coalesce(nullif(v_error_message, ''), 'Unknown inventory error'), 1000)
      );
    exception
      when others then
        null;
    end;

    raise warning 'INVENTORY_CONSUMPTION_FAILED ticket_line=% sqlstate=% error=%',
      new.id,
      v_error_code,
      v_error_message;
    return new;
end;
$$;

revoke all on function public.consume_ticket_line_inventory()
  from public, anon, authenticated;

comment on table public.inventory_consumption_failures is
  'Diagnostics for inventory side effects that were rolled back without rejecting the related sale.';
