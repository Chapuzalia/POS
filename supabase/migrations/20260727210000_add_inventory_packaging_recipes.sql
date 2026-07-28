-- A product is stored in physical units but can be consumed in a different
-- measurement. Example: one Brugal bottle contains 700 ml and a "Cubata"
-- sale consumes 80 ml.

alter table public.inventory_product_settings
  add column if not exists content_quantity numeric(18, 6),
  add column if not exists content_unit_id uuid;

update public.inventory_product_settings
set content_quantity = coalesce(content_quantity, 1),
    content_unit_id = coalesce(content_unit_id, unit_id)
where content_quantity is null
   or content_unit_id is null;

alter table public.inventory_product_settings
  alter column content_quantity set default 1,
  alter column content_quantity set not null,
  alter column content_unit_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.inventory_product_settings'::regclass
      and conname = 'inventory_product_settings_content_quantity_check'
  ) then
    alter table public.inventory_product_settings
      add constraint inventory_product_settings_content_quantity_check
      check (content_quantity > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.inventory_product_settings'::regclass
      and conname = 'inventory_product_settings_content_unit_scope_fk'
  ) then
    alter table public.inventory_product_settings
      add constraint inventory_product_settings_content_unit_scope_fk
      foreign key (content_unit_id, tenant_id, venue_id)
      references public.inventory_units(id, tenant_id, venue_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.catalog_sale_formats'::regclass
      and conname = 'catalog_sale_formats_inventory_scope_unique'
  ) then
    alter table public.catalog_sale_formats
      add constraint catalog_sale_formats_inventory_scope_unique
      unique (id, tenant_id, venue_id);
  end if;
end;
$$;

create table if not exists public.inventory_product_format_consumptions (
  product_id uuid not null,
  sale_format_id uuid not null,
  tenant_id uuid not null,
  venue_id uuid not null,
  quantity numeric(18, 6) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, sale_format_id),
  constraint inventory_product_format_consumptions_quantity_check
    check (quantity > 0),
  constraint inventory_product_format_consumptions_product_scope_fk
    foreign key (product_id, tenant_id, venue_id)
    references public.inventory_product_settings(product_id, tenant_id, venue_id)
    on delete cascade,
  constraint inventory_product_format_consumptions_format_scope_fk
    foreign key (sale_format_id, tenant_id, venue_id)
    references public.catalog_sale_formats(id, tenant_id, venue_id)
    on delete cascade
);

create index if not exists inventory_product_format_consumptions_venue_idx
  on public.inventory_product_format_consumptions (
    tenant_id,
    venue_id,
    product_id
  );

drop trigger if exists set_inventory_product_format_consumptions_updated_at
  on public.inventory_product_format_consumptions;
create trigger set_inventory_product_format_consumptions_updated_at
before update on public.inventory_product_format_consumptions
for each row execute function public.set_updated_at();

create or replace function public.set_inventory_product_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_product_id uuid,
  p_unit_id uuid,
  p_content_quantity numeric,
  p_content_unit_id uuid,
  p_levels jsonb,
  p_consumptions jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_consumptions jsonb := coalesce(p_consumptions, '[]'::jsonb);
  v_consumption jsonb;
  v_consumption_count integer;
  v_content_decimal_places integer;
  v_current_content_quantity numeric(18, 6);
  v_current_content_unit_id uuid;
  v_current_unit_id uuid;
  v_valid_format_count integer;
begin
  if not public.user_is_tenant_admin(p_tenant_id) then
    raise exception 'INVENTORY_FORBIDDEN' using errcode = '42501';
  end if;

  select u.decimal_places
  into v_content_decimal_places
  from public.inventory_units u
  where u.id = p_content_unit_id
    and u.tenant_id = p_tenant_id
    and u.venue_id = p_venue_id
    and u.is_active = true;

  if v_content_decimal_places is null then
    raise exception 'INVENTORY_CONTENT_UNIT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_content_quantity is null
    or p_content_quantity <= 0
    or p_content_quantity > 999999999999.999999
    or round(p_content_quantity, v_content_decimal_places) <> p_content_quantity
  then
    raise exception 'INVENTORY_INVALID_CONTENT_QUANTITY' using errcode = '22023';
  end if;

  if jsonb_typeof(v_consumptions) <> 'array' then
    raise exception 'INVENTORY_INVALID_CONSUMPTIONS' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_consumptions) item
    where jsonb_typeof(item) <> 'object'
      or nullif(btrim(item ->> 'saleFormatId'), '') is null
      or (item ->> 'saleFormatId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(item -> 'quantity') <> 'number'
      or (item ->> 'quantity')::numeric <= 0
      or (item ->> 'quantity')::numeric > 999999999999.999999
      or round((item ->> 'quantity')::numeric, v_content_decimal_places)
        <> (item ->> 'quantity')::numeric
  ) then
    raise exception 'INVENTORY_INVALID_CONSUMPTIONS' using errcode = '22023';
  end if;

  select count(*)
  into v_consumption_count
  from jsonb_array_elements(v_consumptions);

  if (
    select count(distinct item ->> 'saleFormatId')
    from jsonb_array_elements(v_consumptions) item
  ) <> v_consumption_count then
    raise exception 'INVENTORY_DUPLICATE_SALE_FORMAT' using errcode = '22023';
  end if;

  select count(*)
  into v_valid_format_count
  from public.catalog_sale_formats f
  where f.tenant_id = p_tenant_id
    and f.venue_id = p_venue_id
    and f.is_active = true
    and f.id in (
      select (item ->> 'saleFormatId')::uuid
      from jsonb_array_elements(v_consumptions) item
    )
    and exists (
      select 1
      from public.product_variants pv
      where pv.product_id = p_product_id
        and pv.tenant_id = p_tenant_id
        and pv.venue_id = p_venue_id
        and pv.catalog_sale_format_id = f.id
        and pv.is_active = true
    );

  if v_valid_format_count <> v_consumption_count then
    raise exception 'INVENTORY_SALE_FORMAT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select s.unit_id, s.content_quantity, s.content_unit_id
  into v_current_unit_id, v_current_content_quantity, v_current_content_unit_id
  from public.inventory_product_settings s
  where s.product_id = p_product_id
    and s.tenant_id = p_tenant_id
    and s.venue_id = p_venue_id;

  if v_current_unit_id is not null
    and (
      v_current_unit_id is distinct from p_unit_id
      or v_current_content_quantity is distinct from p_content_quantity
      or v_current_content_unit_id is distinct from p_content_unit_id
    )
    and exists (
      select 1
      from public.inventory_stock_levels l
      where l.product_id = p_product_id
        and l.tenant_id = p_tenant_id
        and l.venue_id = p_venue_id
        and l.quantity <> 0
    )
  then
    raise exception 'INVENTORY_PACKAGE_CHANGE_WITH_STOCK' using errcode = '22023';
  end if;

  insert into public.inventory_product_settings (
    product_id,
    tenant_id,
    venue_id,
    unit_id,
    content_quantity,
    content_unit_id
  )
  values (
    p_product_id,
    p_tenant_id,
    p_venue_id,
    p_unit_id,
    p_content_quantity::numeric(18, 6),
    p_content_unit_id
  )
  on conflict (product_id) do update
  set unit_id = excluded.unit_id,
      content_quantity = excluded.content_quantity,
      content_unit_id = excluded.content_unit_id,
      updated_at = now();

  perform public.set_inventory_product_stock(
    p_tenant_id,
    p_venue_id,
    p_product_id,
    p_unit_id,
    p_levels
  );

  delete from public.inventory_product_format_consumptions
  where product_id = p_product_id
    and tenant_id = p_tenant_id
    and venue_id = p_venue_id;

  for v_consumption in
    select item from jsonb_array_elements(v_consumptions) item
  loop
    insert into public.inventory_product_format_consumptions (
      product_id,
      sale_format_id,
      tenant_id,
      venue_id,
      quantity
    )
    values (
      p_product_id,
      (v_consumption ->> 'saleFormatId')::uuid,
      p_tenant_id,
      p_venue_id,
      (v_consumption ->> 'quantity')::numeric(18, 6)
    );
  end loop;
end;
$$;

alter table public.inventory_product_format_consumptions enable row level security;

drop policy if exists inventory_product_format_consumptions_select
  on public.inventory_product_format_consumptions;
create policy inventory_product_format_consumptions_select
on public.inventory_product_format_consumptions
for select
to authenticated
using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);

revoke all on table public.inventory_product_format_consumptions from public, anon;
grant select on table public.inventory_product_format_consumptions to authenticated;

revoke execute on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  jsonb
) from authenticated;
revoke all on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  uuid,
  jsonb,
  jsonb
) from public, anon;
grant execute on function public.set_inventory_product_stock(
  uuid,
  uuid,
  uuid,
  uuid,
  numeric,
  uuid,
  jsonb,
  jsonb
) to authenticated;

comment on column public.inventory_product_settings.unit_id is
  'Physical stock unit, for example bottle.';
comment on column public.inventory_product_settings.content_quantity is
  'Consumable content contained in one physical stock unit, for example 700.';
comment on column public.inventory_product_settings.content_unit_id is
  'Unit used by format recipes, for example millilitres.';
comment on table public.inventory_product_format_consumptions is
  'Amount of product content consumed by one sale in each configured sale format.';
