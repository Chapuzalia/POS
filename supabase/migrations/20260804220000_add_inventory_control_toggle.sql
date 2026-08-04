-- Allow each venue to disable inventory control completely while keeping the
-- Stock page available as the place where it can be enabled again.

alter table public.venues
  add column if not exists inventory_enabled boolean not null default true;

create or replace function public.set_venue_inventory_enabled(
  p_venue_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_venue public.venues%rowtype;
begin
  if p_enabled is null then
    raise exception 'INVENTORY_INVALID_ENABLED' using errcode = '22023';
  end if;

  select * into v_venue
  from public.venues
  where id = p_venue_id
  for update;

  if v_venue.id is null
    or not public.user_is_tenant_admin(v_venue.tenant_id)
  then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;

  update public.venues
  set inventory_enabled = p_enabled,
      updated_at = now()
  where id = v_venue.id;

  return p_enabled;
end;
$$;

revoke all on function public.set_venue_inventory_enabled(uuid, boolean)
  from public, anon;
grant execute on function public.set_venue_inventory_enabled(uuid, boolean)
  to authenticated;

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
end;
$$;

revoke all on function public.consume_ticket_line_inventory()
  from public, anon, authenticated;

comment on column public.venues.inventory_enabled is
  'Master switch for all automatic inventory control in this venue.';
comment on function public.set_venue_inventory_enabled(uuid, boolean) is
  'Enables or disables all inventory control for a venue.';
