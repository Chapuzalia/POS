begin;

-- Reusable, venue-scoped sale formats. This intentionally uses a new catalog
-- relation instead of restoring the legacy sale_formats compatibility table.
create table public.catalog_sale_formats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id, venue_id)
);

create unique index catalog_sale_formats_venue_name_idx
  on public.catalog_sale_formats (tenant_id, venue_id, lower(trim(name)));
create index catalog_sale_formats_venue_order_idx
  on public.catalog_sale_formats (tenant_id, venue_id, is_active, sort_order, id);

create trigger catalog_sale_formats_updated_at
before update on public.catalog_sale_formats
for each row execute function public.set_updated_at();

alter table public.product_variants add column catalog_sale_format_id uuid;
alter table public.product_variants
  add constraint product_variants_catalog_sale_format_fkey
  foreign key (catalog_sale_format_id) references public.catalog_sale_formats(id) on delete restrict;
create index product_variants_catalog_sale_format_idx
  on public.product_variants (tenant_id, venue_id, catalog_sale_format_id, is_active, sort_order);

-- Preserve every existing variant by creating one reusable format for each
-- distinct name in the venue and linking the variant to it.
with distinct_names as (
  select tenant_id, venue_id, lower(trim(name)) as normalized_name,
    min(trim(name)) as name, min(sort_order) as sort_order
  from public.product_variants
  group by tenant_id, venue_id, lower(trim(name))
)
insert into public.catalog_sale_formats(tenant_id, venue_id, name, is_active, sort_order)
select tenant_id, venue_id, name, true,
  row_number() over (partition by tenant_id, venue_id order by sort_order, name) * 10
from distinct_names;

update public.product_variants v
set catalog_sale_format_id = f.id
from public.catalog_sale_formats f
where f.tenant_id = v.tenant_id and f.venue_id = v.venue_id
  and lower(trim(f.name)) = lower(trim(v.name));

alter table public.catalog_sale_formats enable row level security;
create policy catalog_sale_formats_select on public.catalog_sale_formats
for select to authenticated using (
  public.user_is_tenant_admin(tenant_id)
  or public.user_has_venue_access(tenant_id, venue_id)
);
create policy catalog_sale_formats_admin_manage on public.catalog_sale_formats
for all to authenticated using (public.user_is_tenant_admin(tenant_id))
with check (public.user_is_tenant_admin(tenant_id));

revoke all on public.catalog_sale_formats from anon;
grant select on public.catalog_sale_formats to authenticated;

-- Extend the aggregate without duplicating the mature definitive catalog RPC.
alter function public.get_catalog(uuid, text) rename to get_catalog_without_formats;

create function public.get_catalog(p_venue_id uuid, p_mode text default 'admin')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_catalog jsonb;
  v_active_only boolean;
begin
  v_catalog := public.get_catalog_without_formats(p_venue_id, p_mode);
  v_active_only := p_mode = 'pos';
  return v_catalog || jsonb_build_object(
    'sale_formats', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name, x.id)
      from (
        select f.id, f.tenant_id, f.venue_id, f.name, f.is_active,
          f.sort_order, f.created_at, f.updated_at
        from public.catalog_sale_formats f
        where f.venue_id = p_venue_id and (not v_active_only or f.is_active)
      ) x
    ), '[]'::jsonb),
    'variant_formats', coalesce((
      select jsonb_agg(jsonb_build_object('variant_id', v.id, 'format_id', f.id)
        order by v.product_id, v.sort_order, v.id)
      from public.product_variants v
      join public.products p on p.id = v.product_id and p.venue_id = p_venue_id
      join public.catalog_sale_formats f on f.id = v.catalog_sale_format_id and f.venue_id = p_venue_id
      where v.venue_id = p_venue_id
        and (not v_active_only or (p.is_active and v.is_active and f.is_active))
    ), '[]'::jsonb)
  );
end;
$$;

create function public.catalog_sale_format_command(
  p_venue_id uuid,
  p_action text,
  p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_id uuid;
  v_item jsonb;
  v_name text;
begin
  select v.tenant_id into v_tenant_id from public.venues v where v.id = p_venue_id for update;
  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;

  if p_action = 'save' then
    v_name := trim(p_payload ->> 'name');
    if coalesce(v_name, '') = '' then raise exception 'CATALOG_SALE_FORMAT_NAME_REQUIRED'; end if;
    v_id := nullif(p_payload ->> 'id', '')::uuid;
    if v_id is null then
      insert into public.catalog_sale_formats(tenant_id, venue_id, name, is_active, sort_order)
      values(v_tenant_id, p_venue_id, v_name, coalesce((p_payload ->> 'active')::boolean, true),
        coalesce((p_payload ->> 'sortOrder')::integer, 0))
      returning id into v_id;
    else
      update public.catalog_sale_formats set
        name = v_name,
        is_active = coalesce((p_payload ->> 'active')::boolean, is_active),
        sort_order = coalesce((p_payload ->> 'sortOrder')::integer, sort_order)
      where id = v_id and venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND'; end if;
    end if;
    update public.product_variants set name = v_name
    where catalog_sale_format_id = v_id and venue_id = p_venue_id;
  elsif p_action = 'delete' then
    v_id := (p_payload ->> 'id')::uuid;
    if exists(select 1 from public.product_variants where catalog_sale_format_id = v_id and venue_id = p_venue_id) then
      raise exception 'CATALOG_SALE_FORMAT_IN_USE';
    end if;
    delete from public.catalog_sale_formats where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND'; end if;
  elsif p_action = 'reorder' then
    for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
      update public.catalog_sale_formats set sort_order = (v_item ->> 'sortOrder')::integer
      where id = (v_item ->> 'id')::uuid and venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND'; end if;
    end loop;
  else
    raise exception 'CATALOG_SALE_FORMAT_ACTION_INVALID';
  end if;
  return jsonb_build_object('result', 'SUCCESS', 'id', v_id);
end;
$$;

create function public.catalog_variant_format_command(
  p_venue_id uuid,
  p_command text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_format_id uuid;
  v_format_name text;
  v_format_active boolean;
  v_result jsonb;
  v_variant_id uuid;
begin
  if p_command not in ('create_variant', 'update_variant') then
    raise exception 'CATALOG_VARIANT_FORMAT_COMMAND_INVALID';
  end if;
  v_format_id := nullif(p_payload ->> 'formatId', '')::uuid;
  if v_format_id is null then raise exception 'CATALOG_VARIANT_FORMAT_REQUIRED'; end if;
  select name, is_active into v_format_name, v_format_active
  from public.catalog_sale_formats where id = v_format_id and venue_id = p_venue_id;
  if v_format_name is null then raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND'; end if;
  if p_command = 'create_variant' and not v_format_active then raise exception 'CATALOG_SALE_FORMAT_INACTIVE'; end if;

  p_payload := jsonb_set(p_payload, '{name}', to_jsonb(v_format_name));
  v_result := public.catalog_command(p_venue_id, p_command, p_payload);
  v_variant_id := (v_result ->> 'id')::uuid;
  update public.product_variants set catalog_sale_format_id = v_format_id, name = v_format_name
  where id = v_variant_id and venue_id = p_venue_id;
  if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;
  return v_result;
end;
$$;

create function public.catalog_command_batch_with_formats(
  p_venue_id uuid,
  p_commands jsonb,
  p_variant_formats jsonb,
  p_new_formats jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_item jsonb;
  v_format_name text;
begin
  if jsonb_typeof(p_variant_formats) <> 'array' or jsonb_array_length(p_variant_formats) = 0 then
    raise exception 'CATALOG_VARIANT_FORMAT_REQUIRED';
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p_new_formats, '[]'::jsonb)) loop
    perform public.catalog_sale_format_command(p_venue_id, 'save', v_item);
  end loop;
  v_result := public.catalog_command_batch(p_venue_id, p_commands);
  for v_item in select value from jsonb_array_elements(p_variant_formats) loop
    select name into v_format_name from public.catalog_sale_formats
    where id = (v_item ->> 'formatId')::uuid and venue_id = p_venue_id and is_active;
    if v_format_name is null then raise exception 'CATALOG_SALE_FORMAT_NOT_FOUND'; end if;
    update public.product_variants set
      catalog_sale_format_id = (v_item ->> 'formatId')::uuid,
      name = v_format_name
    where id = (v_item ->> 'variantId')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;
  end loop;
  return v_result;
end;
$$;

revoke all on function public.get_catalog_without_formats(uuid, text) from public, anon, authenticated;
revoke all on function public.get_catalog(uuid, text) from public, anon;
revoke all on function public.catalog_sale_format_command(uuid, text, jsonb) from public, anon;
revoke all on function public.catalog_variant_format_command(uuid, text, jsonb) from public, anon;
revoke all on function public.catalog_command_batch_with_formats(uuid, jsonb, jsonb, jsonb) from public, anon;

grant execute on function public.get_catalog(uuid, text) to authenticated, service_role;
grant execute on function public.catalog_sale_format_command(uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.catalog_variant_format_command(uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.catalog_command_batch_with_formats(uuid, jsonb, jsonb, jsonb) to authenticated, service_role;

comment on table public.catalog_sale_formats is 'Reusable venue-scoped sale formats assigned to product variants.';
comment on column public.product_variants.catalog_sale_format_id is 'Explicit reusable sale format selected for this variant.';

commit;
