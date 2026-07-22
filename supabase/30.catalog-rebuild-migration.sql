begin;

-- Phase 2 is forward-only. Objects introduced by migration 29 are transformed in
-- place when their final meaning is compatible; source-only objects remain until
-- the cutover so the current CRM/TPV can continue reading them.

alter table public.categories add column if not exists venue_id uuid references public.venues(id) on delete cascade;
alter table public.categories add column if not exists unused boolean not null default false;
alter table public.categories alter column kind drop not null;
alter table public.products alter column category_id drop not null;
alter table public.products alter column kind drop not null;
alter table public.product_variants add column if not exists venue_id uuid references public.venues(id) on delete cascade;
update public.product_variants pv set venue_id = p.venue_id from public.products p where p.id = pv.product_id and pv.venue_id is null;
alter table public.modifier_groups add column if not exists venue_id uuid references public.venues(id) on delete cascade;
update public.modifier_groups mg set venue_id = p.venue_id from public.products p where p.id = mg.product_id and mg.venue_id is null;
alter table public.modifier_groups alter column product_id drop not null;
alter table public.modifiers add column if not exists venue_id uuid references public.venues(id) on delete cascade;
update public.modifiers m set venue_id = mg.venue_id from public.modifier_groups mg where mg.id = m.group_id and m.venue_id is null;
alter table public.catalog_placements alter column category_id drop not null;
alter table public.catalog_placements add column if not exists variant_id uuid references public.product_variants(id) on delete restrict;
alter table public.catalog_placements drop constraint if exists catalog_placements_tenant_id_venue_id_tab_id_category_id_product_key;

create unique index if not exists categories_catalog_scope_idx on public.categories (id, tenant_id, venue_id);
create unique index if not exists products_catalog_scope_idx on public.products (id, tenant_id, venue_id);
create unique index if not exists product_variants_catalog_scope_idx on public.product_variants (id, product_id, tenant_id, venue_id);
create unique index if not exists modifier_groups_catalog_scope_idx on public.modifier_groups (id, tenant_id, venue_id);
create unique index if not exists catalog_placements_identity_final_idx on public.catalog_placements
  (product_id, tab_id, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.catalog_tab_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  tab_id uuid not null,
  category_id uuid not null,
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tab_id, category_id),
  foreign key (tab_id, tenant_id, venue_id) references public.catalog_tabs(id, tenant_id, venue_id) on delete cascade,
  foreign key (category_id, tenant_id, venue_id) references public.categories(id, tenant_id, venue_id) on delete cascade
);

create table if not exists public.selection_group_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  group_id uuid not null,
  product_id uuid not null,
  variant_id uuid,
  supplement_cents integer not null default 0 check (supplement_cents between -100000000 and 100000000),
  default_quantity integer not null default 0 check (default_quantity >= 0),
  max_quantity integer check (max_quantity is null or max_quantity >= default_quantity),
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (group_id, tenant_id, venue_id) references public.selection_groups(id, tenant_id, venue_id) on delete cascade,
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade,
  foreign key (variant_id, product_id, tenant_id, venue_id) references public.product_variants(id, product_id, tenant_id, venue_id) on delete restrict
);
create unique index if not exists selection_group_options_identity_idx on public.selection_group_options
  (group_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.product_selection_group_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  product_id uuid not null,
  group_id uuid not null,
  display_name text,
  min_selection integer not null default 0 check (min_selection >= 0),
  max_selection integer not null default 1 check (max_selection >= 1 and max_selection >= min_selection),
  applies_to_all_variants boolean not null default true,
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, group_id),
  unique (id, product_id, tenant_id, venue_id),
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade,
  foreign key (group_id, tenant_id, venue_id) references public.selection_groups(id, tenant_id, venue_id) on delete cascade
);
create table if not exists public.product_selection_group_assignment_variants (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  assignment_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (assignment_id, variant_id),
  foreign key (assignment_id, product_id, tenant_id, venue_id) references public.product_selection_group_assignments(id, product_id, tenant_id, venue_id) on delete cascade,
  foreign key (variant_id, product_id, tenant_id, venue_id) references public.product_variants(id, product_id, tenant_id, venue_id) on delete cascade
);

create table if not exists public.product_modifier_group_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  product_id uuid not null,
  group_id uuid not null,
  display_name text,
  min_selection integer not null default 0 check (min_selection >= 0),
  max_selection integer not null default 1 check (max_selection >= 1 and max_selection >= min_selection),
  applies_to_all_variants boolean not null default true,
  sort_order integer not null default 0 check (sort_order >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, group_id),
  unique (id, product_id, tenant_id, venue_id),
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade,
  foreign key (group_id, tenant_id, venue_id) references public.modifier_groups(id, tenant_id, venue_id) on delete cascade
);
create table if not exists public.product_modifier_group_assignment_variants (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  assignment_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (assignment_id, variant_id),
  foreign key (assignment_id, product_id, tenant_id, venue_id) references public.product_modifier_group_assignments(id, product_id, tenant_id, venue_id) on delete cascade,
  foreign key (variant_id, product_id, tenant_id, venue_id) references public.product_variants(id, product_id, tenant_id, venue_id) on delete cascade
);

alter table public.modifiers add column if not exists supplement_cents integer not null default 0;
alter table public.modifiers drop constraint if exists modifiers_supplement_cents_check;
alter table public.modifiers add constraint modifiers_supplement_cents_check check (supplement_cents between -100000000 and 100000000) not valid;
alter table public.modifiers validate constraint modifiers_supplement_cents_check;

create table if not exists public.product_images (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  product_id uuid not null,
  storage_path text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  unique (product_id),
  foreign key (product_id, tenant_id, venue_id) references public.products(id, tenant_id, venue_id) on delete cascade
);

-- Historical rows intentionally keep UUID values and normalized snapshots, but
-- do not have foreign keys to mutable catalogue configuration.
alter table public.ticket_lines drop constraint if exists ticket_lines_product_id_fkey;
alter table public.ticket_lines drop constraint if exists ticket_lines_variant_id_fkey;
alter table public.ticket_lines drop constraint if exists ticket_lines_sale_format_id_fkey;
alter table public.ticket_line_components drop constraint if exists ticket_line_components_selection_group_id_fkey;
alter table public.ticket_line_components drop constraint if exists ticket_line_components_product_id_fkey;
alter table public.ticket_line_components drop constraint if exists ticket_line_components_variant_id_fkey;
alter table public.order_line_components drop constraint if exists order_line_components_selection_group_id_fkey;
alter table public.order_line_components drop constraint if exists order_line_components_product_id_fkey;
alter table public.order_line_components drop constraint if exists order_line_components_variant_id_fkey;
alter table public.ticket_line_components drop constraint if exists ticket_line_components_price_delta_cents_check;
alter table public.ticket_line_components add constraint ticket_line_components_price_delta_cents_check check (price_delta_cents between -100000000 and 100000000) not valid;
alter table public.order_line_components drop constraint if exists order_line_components_price_delta_cents_check;
alter table public.order_line_components add constraint order_line_components_price_delta_cents_check check (price_delta_cents between -100000000 and 100000000) not valid;

create table if not exists public.catalog_audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid,
  venue_id uuid,
  table_name text not null,
  row_id uuid,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  actor_id uuid,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists catalog_audit_log_scope_idx on public.catalog_audit_log (tenant_id, venue_id, created_at desc);

create or replace function public.audit_catalog_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.catalog_audit_log(tenant_id, venue_id, table_name, row_id, action, actor_id, before_data, after_data)
  values ((v_row->>'tenant_id')::uuid, nullif(v_row->>'venue_id','')::uuid, tg_table_name, nullif(v_row->>'id','')::uuid, tg_op, auth.uid(), case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end, case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end; $$;

create or replace function public.validate_catalog_entity()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.venues v where v.id = new.venue_id and v.tenant_id = new.tenant_id) then raise exception 'CATALOG_SCOPE_MISMATCH'; end if;
  if tg_table_name = 'selection_group_options' then
    if (select product_type from public.products where id = new.product_id) <> 'standard' then raise exception 'NESTED_MENU_NOT_ALLOWED'; end if;
  elsif tg_table_name in ('product_selection_group_assignments', 'product_modifier_group_assignments') then
    if new.is_active and not (select is_active from public.products where id = new.product_id) then raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_PRODUCT'; end if;
    if new.is_active and tg_table_name = 'product_selection_group_assignments' and not (select is_active from public.selection_groups where id = new.group_id) then raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_GROUP'; end if;
    if new.is_active and tg_table_name = 'product_modifier_group_assignments' and not (select is_active from public.modifier_groups where id = new.group_id) then raise exception 'ACTIVE_ASSIGNMENT_INACTIVE_GROUP'; end if;
  end if;
  return new;
end; $$;

create or replace function public.validate_product_default_variant()
returns trigger language plpgsql set search_path = '' as $$
declare v_product uuid := coalesce(new.product_id, old.product_id); v_count integer;
begin
  if not exists (select 1 from public.products where id = v_product) then return null; end if;
  select count(*) into v_count from public.product_variants where product_id = v_product and is_active and is_default;
  if v_count <> 1 then raise exception 'INVALID_ACTIVE_DEFAULT_VARIANT_COUNT product %, count %', v_product, v_count; end if;
  return null;
end; $$;

create or replace function public.validate_selection_capacity()
returns trigger language plpgsql set search_path = '' as $$
declare v_group uuid; v_bad uuid;
begin
  v_group := case when tg_table_name = 'selection_group_options' then coalesce(new.group_id, old.group_id) else coalesce(new.group_id, old.group_id) end;
  select a.id into v_bad from public.product_selection_group_assignments a
  where a.group_id = v_group and a.is_active and a.min_selection > (
    select coalesce(sum(coalesce(o.max_quantity, a.max_selection)), 0) from public.selection_group_options o where o.group_id = a.group_id and o.is_active
  ) limit 1;
  if v_bad is not null then raise exception 'INSUFFICIENT_ACTIVE_CAPACITY assignment %', v_bad; end if;
  return null;
end; $$;

drop trigger if exists catalog_variants_default_guard on public.product_variants;
create constraint trigger catalog_variants_default_guard after insert or update or delete on public.product_variants deferrable initially deferred for each row execute function public.validate_product_default_variant();
drop trigger if exists selection_options_capacity_guard on public.selection_group_options;
create constraint trigger selection_options_capacity_guard after insert or update or delete on public.selection_group_options deferrable initially deferred for each row execute function public.validate_selection_capacity();
drop trigger if exists selection_assignments_capacity_guard on public.product_selection_group_assignments;
create constraint trigger selection_assignments_capacity_guard after insert or update or delete on public.product_selection_group_assignments deferrable initially deferred for each row execute function public.validate_selection_capacity();

do $$ declare t text;
begin
  foreach t in array array['categories','products','product_variants','catalog_tabs','catalog_tab_categories','catalog_placements','selection_groups','selection_group_options','product_selection_group_assignments','modifier_groups','modifiers','product_modifier_group_assignments'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_catalog_validate', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.validate_catalog_entity()', t || '_catalog_validate', t);
    if t not in ('product_variants') then
      execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
      execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()', t || '_updated_at', t);
    end if;
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_catalog_change()', t || '_audit', t);
  end loop;
end $$;

create or replace function public.import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid; v_item jsonb; v_ref text; v_product uuid; v_assignment uuid; v_variant_ref text;
  v_existing bigint; v_removed_paths text[] := '{}';
begin
  if p_mode not in ('empty', 'replace') then raise exception 'INVALID_IMPORT_MODE'; end if;
  select tenant_id into v_tenant from public.venues where id = p_venue_id for update;
  if v_tenant is null then raise exception 'VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant) then raise exception 'CATALOG_IMPORT_FORBIDDEN'; end if;
  if p_plan->>'venueId' <> p_venue_id::text then raise exception 'PLAN_VENUE_MISMATCH'; end if;
  select (select count(*) from public.products where venue_id=p_venue_id) + (select count(*) from public.catalog_tabs where venue_id=p_venue_id) + (select count(*) from public.categories where venue_id=p_venue_id) into v_existing;
  if p_mode = 'empty' and v_existing > 0 then raise exception 'CATALOG_NOT_EMPTY'; end if;
  if p_mode = 'replace' then
    select coalesce(array_agg(storage_path), '{}') into v_removed_paths from public.product_images where venue_id=p_venue_id;
    delete from public.products where venue_id=p_venue_id;
    delete from public.catalog_tabs where venue_id=p_venue_id;
    delete from public.selection_groups where venue_id=p_venue_id;
    delete from public.modifier_groups where venue_id=p_venue_id;
    delete from public.categories where venue_id=p_venue_id;
  end if;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,categories}') loop
    v_ref:=v_item->>'ref'; insert into public.categories(id,tenant_id,venue_id,name,icon,sort_order,is_active,unused) values ((p_plan->'generatedIds'->'categories'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',v_item->>'icon',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean,(v_item->>'unused')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,tabs}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_tabs(id,tenant_id,venue_id,key,label,icon,sort_order,is_active) values ((p_plan->'generatedIds'->'tabs'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'key',v_item->>'label',coalesce(v_item->>'icon','receipt'),(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,products}') loop
    v_ref:=v_item->>'ref'; insert into public.products(id,tenant_id,venue_id,category_id,name,description,image_path,product_type,tax_rate,is_active,sort_order) values ((p_plan->'generatedIds'->'products'->>v_ref)::uuid,v_tenant,p_venue_id,null,v_item->>'name',v_item->>'description',p_plan->'imagePaths'->>(v_item->>'imageRef'),v_item->>'type',nullif(v_item->>'taxRate','')::numeric,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,variants}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid;
    insert into public.product_variants(id,tenant_id,venue_id,product_id,name,price_cents,sku,is_default,is_active,sort_order) values ((p_plan->'generatedIds'->'variants'->>v_ref)::uuid,v_tenant,p_venue_id,v_product,v_item->>'name',(v_item->>'priceCents')::integer,v_item->>'sku',(v_item->>'isDefault')::boolean,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,images}') where not (value->>'missing')::boolean loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid;
    insert into public.product_images(id,tenant_id,venue_id,product_id,storage_path,mime_type,size_bytes,sha256) values ((p_plan->'generatedIds'->'images'->>v_ref)::uuid,v_tenant,p_venue_id,v_product,p_plan->'imagePaths'->>v_ref,v_item->>'mimeType',(v_item->>'sizeBytes')::bigint,v_item->>'sha256');
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,tabCategories}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_tab_categories(id,tenant_id,venue_id,tab_id,category_id,sort_order,is_active) values ((p_plan->'generatedIds'->'tabCategories'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'tabs'->>(v_item->>'tabRef'))::uuid,(p_plan->'generatedIds'->'categories'->>(v_item->>'categoryRef'))::uuid,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,placements}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_placements(id,tenant_id,venue_id,tab_id,category_id,product_id,variant_id,is_featured,sort_order,is_active) values ((p_plan->'generatedIds'->'placements'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'tabs'->>(v_item->>'tabRef'))::uuid,(p_plan->'generatedIds'->'categories'->>(v_item->>'categoryRef'))::uuid,(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid,(p_plan->'generatedIds'->'variants'->>(v_item->>'variantRef'))::uuid,(v_item->>'featured')::boolean,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionGroups}') loop
    v_ref:=v_item->>'ref'; insert into public.selection_groups(id,tenant_id,venue_id,kind,name,min_select,max_select,sort_order,is_active) values ((p_plan->'generatedIds'->'selectionGroups'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'type',v_item->>'name',0,1,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionGroupOptions}') loop
    v_ref:=v_item->>'ref'; insert into public.selection_group_options(id,tenant_id,venue_id,group_id,product_id,variant_id,supplement_cents,default_quantity,max_quantity,sort_order,is_active) values ((p_plan->'generatedIds'->'selectionGroupOptions'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'selectionGroups'->>(v_item->>'groupRef'))::uuid,(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid,(p_plan->'generatedIds'->'variants'->>(v_item->>'variantRef'))::uuid,(v_item->>'supplementCents')::integer,(v_item->>'defaultQuantity')::integer,nullif(v_item->>'maxQuantity','')::integer,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionAssignments}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid; v_assignment:=(p_plan->'generatedIds'->'selectionAssignments'->>v_ref)::uuid;
    insert into public.product_selection_group_assignments(id,tenant_id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active) values (v_assignment,v_tenant,p_venue_id,v_product,(p_plan->'generatedIds'->'selectionGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'displayName',(v_item->>'minSelection')::integer,(v_item->>'maxSelection')::integer,jsonb_array_length(v_item->'variantRefs')=0,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
    for v_variant_ref in select jsonb_array_elements_text(v_item->'variantRefs') loop insert into public.product_selection_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id) values(v_tenant,p_venue_id,v_assignment,v_product,(p_plan->'generatedIds'->'variants'->>v_variant_ref)::uuid); end loop;
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifierGroups}') loop
    v_ref:=v_item->>'ref'; insert into public.modifier_groups(id,tenant_id,venue_id,product_id,name,min_select,max_select,sort_order,is_active) values ((p_plan->'generatedIds'->'modifierGroups'->>v_ref)::uuid,v_tenant,p_venue_id,null,v_item->>'name',0,1,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifiers}') loop
    v_ref:=v_item->>'ref'; insert into public.modifiers(id,tenant_id,venue_id,group_id,name,price_cents,supplement_cents,is_default,is_active,sort_order) values ((p_plan->'generatedIds'->'modifiers'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'modifierGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'name',0,(v_item->>'supplementCents')::integer,(v_item->>'isDefault')::boolean,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifierAssignments}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid; v_assignment:=(p_plan->'generatedIds'->'modifierAssignments'->>v_ref)::uuid;
    insert into public.product_modifier_group_assignments(id,tenant_id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active) values (v_assignment,v_tenant,p_venue_id,v_product,(p_plan->'generatedIds'->'modifierGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'displayName',(v_item->>'minSelection')::integer,(v_item->>'maxSelection')::integer,jsonb_array_length(v_item->'variantRefs')=0,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
    for v_variant_ref in select jsonb_array_elements_text(v_item->'variantRefs') loop insert into public.product_modifier_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id) values(v_tenant,p_venue_id,v_assignment,v_product,(p_plan->'generatedIds'->'variants'->>v_variant_ref)::uuid); end loop;
  end loop;
  set constraints all immediate;
  return jsonb_build_object('result','SUCCESS','removedImagePaths',to_jsonb(v_removed_paths));
end; $$;

-- RLS uses venue checks for final rows while retaining access to NULL venue rows
-- that belong to the still-running source catalogue.
do $$ declare t text;
begin
  foreach t in array array['catalog_tab_categories','selection_group_options','product_selection_group_assignments','product_selection_group_assignment_variants','product_modifier_group_assignments','product_modifier_group_assignment_variants','product_images','catalog_audit_log'] loop execute format('alter table public.%I enable row level security', t); end loop;
end $$;
drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories for select to authenticated using (public.user_is_tenant_admin(tenant_id) or venue_id is null or public.user_has_venue_access(tenant_id, venue_id));
drop policy if exists categories_admin_manage on public.categories;
create policy categories_admin_manage on public.categories for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id));
drop policy if exists modifier_groups_select on public.modifier_groups;
create policy modifier_groups_select on public.modifier_groups for select to authenticated using (public.user_is_tenant_admin(tenant_id) or (venue_id is not null and public.user_has_venue_access(tenant_id, venue_id)) or exists(select 1 from public.products p where p.id=product_id and public.user_has_venue_access(p.tenant_id,p.venue_id)));
drop policy if exists modifiers_select on public.modifiers;
create policy modifiers_select on public.modifiers for select to authenticated using (public.user_is_tenant_admin(tenant_id) or (venue_id is not null and public.user_has_venue_access(tenant_id, venue_id)) or exists(select 1 from public.modifier_groups mg join public.products p on p.id=mg.product_id where mg.id=group_id and public.user_has_venue_access(p.tenant_id,p.venue_id)));
do $$ declare t text;
begin
  foreach t in array array['catalog_tab_categories','selection_group_options','product_selection_group_assignments','product_selection_group_assignment_variants','product_modifier_group_assignments','product_modifier_group_assignment_variants','product_images'] loop
    execute format('drop policy if exists %I on public.%I', t||'_select', t);
    execute format('drop policy if exists %I on public.%I', t||'_manage', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id,venue_id))', t||'_select', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.user_is_tenant_admin(tenant_id)) with check (public.user_is_tenant_admin(tenant_id))', t||'_manage', t);
  end loop;
end $$;
drop policy if exists catalog_audit_log_select on public.catalog_audit_log;
create policy catalog_audit_log_select on public.catalog_audit_log for select to authenticated using (public.user_is_tenant_admin(tenant_id));

revoke all on function public.import_catalog(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.import_catalog(uuid,text,jsonb) to service_role;

comment on table public.selection_group_items is '@transitional migration 29 source; replace with selection_group_options at cutover.';
comment on table public.variant_selection_groups is '@transitional migration 29 source; replace with product_selection_group_assignments at cutover.';
comment on table public.product_modifier_groups is '@transitional migration 29 source; replace with product_modifier_group_assignments at cutover.';
comment on column public.catalog_placements.default_variant_id is '@transitional migration 29 source; final field is variant_id.';
comment on column public.modifier_groups.product_id is '@transitional source ownership; final modifier groups are reusable.';
comment on function public.import_catalog(uuid,text,jsonb) is 'Transactional empty/replace catalogue reconstruction. Service role only.';

commit;
