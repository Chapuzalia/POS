-- Supplier document receipts: private tenant purchasing data, reusable global
-- parsing knowledge and one atomic inventory receipt operation.

alter table public.inventory_items
  add column if not exists reference_cost numeric(18, 6);

alter table public.inventory_items
  drop constraint if exists inventory_items_reference_cost_check,
  add constraint inventory_items_reference_cost_check
    check (reference_cost is null or reference_cost >= 0);

create table public.global_suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tax_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint global_suppliers_name_check
    check (btrim(name) <> '' and char_length(name) <= 160)
);

create unique index global_suppliers_tax_id_unique
  on public.global_suppliers (upper(btrim(tax_id)))
  where nullif(btrim(tax_id), '') is not null;

create table public.global_supplier_document_profiles (
  id uuid primary key default gen_random_uuid(),
  global_supplier_id uuid not null references public.global_suppliers(id) on delete cascade,
  document_type text not null,
  fingerprint_json jsonb not null default '{}'::jsonb,
  rules_json jsonb not null,
  status text not null default 'candidate',
  success_count integer not null default 0,
  correction_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint global_supplier_profiles_document_type_check
    check (document_type in ('invoice', 'delivery_note')),
  constraint global_supplier_profiles_status_check
    check (status in ('candidate', 'verified', 'deprecated')),
  constraint global_supplier_profiles_metrics_check
    check (success_count >= 0 and correction_count >= 0),
  constraint global_supplier_profiles_fingerprint_check
    check (jsonb_typeof(fingerprint_json) = 'object'),
  constraint global_supplier_profiles_rules_check
    check (jsonb_typeof(rules_json) = 'object')
);

create index global_supplier_profiles_lookup_idx
  on public.global_supplier_document_profiles
    (global_supplier_id, document_type, status, success_count desc, updated_at desc);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  global_supplier_id uuid references public.global_suppliers(id) on delete set null,
  name text not null,
  tax_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_name_check
    check (btrim(name) <> '' and char_length(name) <= 160),
  constraint suppliers_scope_unique unique (id, tenant_id)
);

create unique index suppliers_tenant_tax_id_unique
  on public.suppliers (tenant_id, upper(btrim(tax_id)))
  where nullif(btrim(tax_id), '') is not null;
create index suppliers_tenant_name_idx
  on public.suppliers (tenant_id, lower(name));

create table public.supplier_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  supplier_id uuid,
  global_supplier_id uuid references public.global_suppliers(id) on delete set null,
  global_profile_id uuid references public.global_supplier_document_profiles(id) on delete set null,
  document_type text not null,
  document_number text,
  document_date date,
  storage_bucket text,
  storage_path text,
  original_file_name text,
  original_mime_type text,
  file_hash text,
  status text not null default 'processing',
  extraction_metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_documents_scope_unique unique (id, tenant_id, venue_id),
  constraint supplier_documents_supplier_scope_fk
    foreign key (supplier_id, tenant_id)
    references public.suppliers(id, tenant_id),
  constraint supplier_documents_type_check
    check (document_type in ('invoice', 'delivery_note')),
  constraint supplier_documents_status_check
    check (status in ('processing', 'review', 'confirmed', 'error')),
  constraint supplier_documents_hash_check
    check (file_hash is null or file_hash ~ '^[a-fA-F0-9]{64}$'),
  constraint supplier_documents_metadata_check
    check (jsonb_typeof(extraction_metadata) = 'object'),
  constraint supplier_documents_confirmation_check
    check (
      (status = 'confirmed' and confirmed_by is not null and confirmed_at is not null)
      or (status <> 'confirmed' and confirmed_at is null)
    )
);

create unique index supplier_documents_file_hash_unique
  on public.supplier_documents (tenant_id, venue_id, lower(file_hash))
  where file_hash is not null;
create unique index supplier_documents_number_unique
  on public.supplier_documents (
    tenant_id, venue_id, supplier_id, document_type, lower(btrim(document_number))
  )
  where supplier_id is not null and nullif(btrim(document_number), '') is not null;
create index supplier_documents_review_idx
  on public.supplier_documents (tenant_id, venue_id, status, created_at desc);

create table public.supplier_document_lines (
  id uuid primary key default gen_random_uuid(),
  supplier_document_id uuid not null,
  tenant_id uuid not null,
  venue_id uuid not null,
  line_number integer not null,
  supplier_reference text,
  description_raw text not null,
  description_normalized text not null default '',
  barcode text,
  quantity numeric(18, 6),
  purchase_unit text,
  package_count numeric(18, 6),
  package_unit_quantity numeric(18, 6),
  package_unit_symbol text,
  unit_price numeric(18, 6),
  discount_amount numeric(18, 6) not null default 0,
  gross_cost numeric(18, 6),
  net_cost numeric(18, 6),
  line_total numeric(18, 6),
  tax_rate numeric(7, 4),
  inventory_item_id uuid,
  warehouse_id uuid,
  base_quantity numeric(18, 6),
  normalized_unit_cost numeric(18, 6),
  match_status text not null default 'needs_review',
  extraction_confidence numeric(5, 4),
  update_reference_cost boolean not null default false,
  reference_cost_decided boolean not null default false,
  was_corrected boolean not null default false,
  raw_extraction_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_document_lines_scope_unique unique (id, tenant_id, venue_id),
  constraint supplier_document_lines_document_order_unique
    unique (supplier_document_id, line_number),
  constraint supplier_document_lines_document_scope_fk
    foreign key (supplier_document_id, tenant_id, venue_id)
    references public.supplier_documents(id, tenant_id, venue_id) on delete cascade,
  constraint supplier_document_lines_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id),
  constraint supplier_document_lines_warehouse_scope_fk
    foreign key (warehouse_id, tenant_id, venue_id)
    references public.inventory_warehouses(id, tenant_id, venue_id),
  constraint supplier_document_lines_number_check check (line_number >= 1),
  constraint supplier_document_lines_amounts_check check (
    (quantity is null or quantity > 0)
    and (package_count is null or package_count > 0)
    and (package_unit_quantity is null or package_unit_quantity > 0)
    and (unit_price is null or unit_price >= 0)
    and discount_amount >= 0
    and (gross_cost is null or gross_cost >= 0)
    and (net_cost is null or net_cost >= 0)
    and (line_total is null or line_total >= 0)
    and (tax_rate is null or tax_rate >= 0)
    and (base_quantity is null or base_quantity > 0)
    and (normalized_unit_cost is null or normalized_unit_cost >= 0)
  ),
  constraint supplier_document_lines_match_status_check
    check (match_status in ('recognized', 'probable', 'needs_review')),
  constraint supplier_document_lines_confidence_check
    check (extraction_confidence is null or extraction_confidence between 0 and 1),
  constraint supplier_document_lines_metadata_check
    check (jsonb_typeof(raw_extraction_metadata) = 'object')
);

create index supplier_document_lines_document_idx
  on public.supplier_document_lines (supplier_document_id, line_number);
create index supplier_document_lines_item_cost_idx
  on public.supplier_document_lines
    (tenant_id, venue_id, inventory_item_id, created_at desc)
  where inventory_item_id is not null;

create table public.supplier_item_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  supplier_id uuid not null,
  alias_type text not null,
  alias_value text not null,
  inventory_item_id uuid not null,
  packaging_json jsonb not null default '{}'::jsonb,
  confirmation_count integer not null default 1,
  last_confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_item_aliases_scope_unique unique (id, tenant_id, venue_id),
  constraint supplier_item_aliases_supplier_scope_fk
    foreign key (supplier_id, tenant_id)
    references public.suppliers(id, tenant_id) on delete cascade,
  constraint supplier_item_aliases_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id) on delete cascade,
  constraint supplier_item_aliases_type_check
    check (alias_type in ('ean', 'supplier_reference', 'description')),
  constraint supplier_item_aliases_value_check
    check (btrim(alias_value) <> ''),
  constraint supplier_item_aliases_packaging_check
    check (jsonb_typeof(packaging_json) = 'object'),
  constraint supplier_item_aliases_confirmation_check
    check (confirmation_count > 0),
  constraint supplier_item_aliases_unique
    unique (tenant_id, venue_id, supplier_id, alias_type, alias_value)
);

create index supplier_item_aliases_item_idx
  on public.supplier_item_aliases (tenant_id, venue_id, inventory_item_id);

create table public.inventory_reference_cost_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  inventory_item_id uuid not null,
  supplier_document_id uuid not null,
  supplier_document_line_id uuid not null,
  previous_cost numeric(18, 6),
  new_cost numeric(18, 6) not null,
  changed_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint inventory_reference_cost_history_item_scope_fk
    foreign key (inventory_item_id, tenant_id, venue_id)
    references public.inventory_items(id, tenant_id, venue_id),
  constraint inventory_reference_cost_history_document_scope_fk
    foreign key (supplier_document_id, tenant_id, venue_id)
    references public.supplier_documents(id, tenant_id, venue_id),
  constraint inventory_reference_cost_history_line_scope_fk
    foreign key (supplier_document_line_id, tenant_id, venue_id)
    references public.supplier_document_lines(id, tenant_id, venue_id),
  constraint inventory_reference_cost_history_values_check
    check (
      (previous_cost is null or previous_cost >= 0)
      and new_cost >= 0
      and previous_cost is distinct from new_cost
    )
);

create index inventory_reference_cost_history_item_idx
  on public.inventory_reference_cost_history
    (tenant_id, venue_id, inventory_item_id, created_at desc);

-- The bucket is private. Object paths are always
-- tenant_id/venue_id/document_id/sanitized-file-name.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'supplier-documents',
  'supplier-documents',
  false,
  20971520,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_access_supplier_document_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_parts text[];
  v_tenant_id uuid;
  v_venue_id uuid;
  v_document_id uuid;
begin
  v_parts := storage.foldername(p_name);
  if coalesce(array_length(v_parts, 1), 0) <> 3 then return false; end if;
  v_tenant_id := v_parts[1]::uuid;
  v_venue_id := v_parts[2]::uuid;
  v_document_id := v_parts[3]::uuid;
  return (
    public.user_is_tenant_admin(v_tenant_id)
    or public.user_has_venue_access(v_tenant_id, v_venue_id)
  ) and exists (
    select 1
    from public.supplier_documents document
    where document.id = v_document_id
      and document.tenant_id = v_tenant_id
      and document.venue_id = v_venue_id
      and document.storage_bucket = 'supplier-documents'
      and document.storage_path = p_name
  );
exception when invalid_text_representation then
  return false;
end;
$$;

drop policy if exists supplier_documents_storage_read on storage.objects;
drop policy if exists supplier_documents_storage_insert on storage.objects;
drop policy if exists supplier_documents_storage_delete on storage.objects;

create policy supplier_documents_storage_read
on storage.objects for select to authenticated
using (
  bucket_id = 'supplier-documents'
  and public.can_access_supplier_document_object(name)
);
create policy supplier_documents_storage_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'supplier-documents'
  and public.can_access_supplier_document_object(name)
);
create policy supplier_documents_storage_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'supplier-documents'
  and public.can_access_supplier_document_object(name)
);

create or replace function public.create_supplier_document(
  p_venue_id uuid,
  p_document_type text,
  p_original_file_name text default null,
  p_original_mime_type text default null,
  p_file_hash text default null,
  p_mock_fixture_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_document_id uuid := gen_random_uuid();
  v_existing public.supplier_documents%rowtype;
  v_safe_name text;
  v_storage_path text;
begin
  select venue.tenant_id into v_tenant_id
  from public.venues venue
  where venue.id = p_venue_id and venue.is_active;
  if v_tenant_id is null then
    raise exception 'SUPPLIER_DOCUMENT_VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.user_is_tenant_admin(v_tenant_id)
    and not public.user_has_venue_access(v_tenant_id, p_venue_id)
  then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if p_document_type not in ('invoice', 'delivery_note') then
    raise exception 'SUPPLIER_DOCUMENT_INVALID_TYPE' using errcode = '22023';
  end if;
  if p_file_hash is not null and p_file_hash !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'SUPPLIER_DOCUMENT_INVALID_HASH' using errcode = '22023';
  end if;
  if p_file_hash is not null then
    select document.* into v_existing
    from public.supplier_documents document
    where document.tenant_id = v_tenant_id
      and document.venue_id = p_venue_id
      and lower(document.file_hash) = lower(p_file_hash)
    limit 1;
    if v_existing.id is not null then
      return jsonb_build_object(
        'documentId', v_existing.id,
        'storageBucket', v_existing.storage_bucket,
        'storagePath', v_existing.storage_path,
        'status', v_existing.status,
        'duplicate', true
      );
    end if;
  end if;
  if p_original_file_name is not null then
    v_safe_name := left(regexp_replace(p_original_file_name, '[^a-zA-Z0-9._-]+', '_', 'g'), 180);
    if btrim(v_safe_name) = '' then v_safe_name := 'document'; end if;
    v_storage_path := v_tenant_id || '/' || p_venue_id || '/' || v_document_id || '/' || v_safe_name;
  end if;
  insert into public.supplier_documents (
    id, tenant_id, venue_id, document_type, storage_bucket, storage_path,
    original_file_name, original_mime_type, file_hash, extraction_metadata, created_by
  ) values (
    v_document_id, v_tenant_id, p_venue_id, p_document_type,
    case when v_storage_path is null then null else 'supplier-documents' end,
    v_storage_path, p_original_file_name, p_original_mime_type, lower(p_file_hash),
    case when p_mock_fixture_id is null then '{}'::jsonb
      else jsonb_build_object('mockFixtureId', p_mock_fixture_id) end,
    auth.uid()
  );
  return jsonb_build_object(
    'documentId', v_document_id,
    'storageBucket', case when v_storage_path is null then null else 'supplier-documents' end,
    'storagePath', v_storage_path,
    'status', 'processing',
    'duplicate', false
  );
end;
$$;

create or replace function public.save_supplier_document_line(
  p_document_id uuid,
  p_line_id uuid,
  p_inventory_item_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_purchase_unit text,
  p_package_count numeric,
  p_package_unit_quantity numeric,
  p_package_unit_symbol text,
  p_unit_price numeric,
  p_discount_amount numeric,
  p_base_quantity numeric,
  p_normalized_unit_cost numeric,
  p_update_reference_cost boolean,
  p_reference_cost_decided boolean
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_document public.supplier_documents%rowtype;
  v_line public.supplier_document_lines%rowtype;
begin
  select document.* into v_document
  from public.supplier_documents document
  where document.id = p_document_id
  for update;
  if v_document.id is null then
    raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.user_is_tenant_admin(v_document.tenant_id)
    and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
  then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if v_document.status <> 'review' then
    raise exception 'SUPPLIER_DOCUMENT_NOT_EDITABLE' using errcode = '55000';
  end if;
  select line.* into v_line
  from public.supplier_document_lines line
  where line.id = p_line_id
    and line.supplier_document_id = p_document_id
    and line.tenant_id = v_document.tenant_id
    and line.venue_id = v_document.venue_id;
  if v_line.id is null then
    raise exception 'SUPPLIER_DOCUMENT_LINE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.inventory_items item
    where item.id = p_inventory_item_id
      and item.tenant_id = v_document.tenant_id
      and item.venue_id = v_document.venue_id
      and item.is_active
  ) then raise exception 'SUPPLIER_DOCUMENT_ITEM_INVALID' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.inventory_warehouses warehouse
    where warehouse.id = p_warehouse_id
      and warehouse.tenant_id = v_document.tenant_id
      and warehouse.venue_id = v_document.venue_id
      and warehouse.is_active
  ) then raise exception 'SUPPLIER_DOCUMENT_WAREHOUSE_INVALID' using errcode = '22023'; end if;
  if coalesce(p_quantity, 0) <= 0
    or coalesce(p_base_quantity, 0) <= 0
    or coalesce(p_unit_price, -1) < 0
    or coalesce(p_discount_amount, 0) < 0
    or coalesce(p_normalized_unit_cost, -1) < 0
  then raise exception 'SUPPLIER_DOCUMENT_LINE_INVALID' using errcode = '22023'; end if;
  update public.supplier_document_lines
  set inventory_item_id = p_inventory_item_id,
      warehouse_id = p_warehouse_id,
      quantity = round(p_quantity, 6),
      purchase_unit = nullif(btrim(p_purchase_unit), ''),
      package_count = p_package_count,
      package_unit_quantity = p_package_unit_quantity,
      package_unit_symbol = nullif(btrim(p_package_unit_symbol), ''),
      unit_price = round(p_unit_price, 6),
      discount_amount = round(coalesce(p_discount_amount, 0), 6),
      base_quantity = round(p_base_quantity, 6),
      normalized_unit_cost = round(p_normalized_unit_cost, 6),
      match_status = 'recognized',
      update_reference_cost = coalesce(p_update_reference_cost, false),
      reference_cost_decided = coalesce(p_reference_cost_decided, false),
      was_corrected = was_corrected or
        inventory_item_id is distinct from p_inventory_item_id or
        warehouse_id is distinct from p_warehouse_id or
        quantity is distinct from round(p_quantity, 6) or
        base_quantity is distinct from round(p_base_quantity, 6) or
        normalized_unit_cost is distinct from round(p_normalized_unit_cost, 6),
      updated_at = now()
  where id = p_line_id;
end;
$$;

create or replace function public.create_inventory_item_from_supplier_document(
  p_document_id uuid,
  p_name text,
  p_base_unit_id uuid,
  p_warehouse_id uuid,
  p_reference_cost numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_document public.supplier_documents%rowtype;
  v_item_id uuid := gen_random_uuid();
begin
  select document.* into v_document
  from public.supplier_documents document
  where document.id = p_document_id;
  if v_document.id is null or v_document.status <> 'review' then
    raise exception 'SUPPLIER_DOCUMENT_NOT_EDITABLE' using errcode = '55000';
  end if;
  if not public.user_is_tenant_admin(v_document.tenant_id)
    and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
  then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if btrim(coalesce(p_name, '')) = '' or char_length(btrim(p_name)) > 120 then
    raise exception 'INVENTORY_INVALID_NAME' using errcode = '22023';
  end if;
  if p_reference_cost is not null and p_reference_cost < 0 then
    raise exception 'INVENTORY_INVALID_REFERENCE_COST' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.inventory_units unit
    where unit.id = p_base_unit_id
      and unit.tenant_id = v_document.tenant_id
      and unit.venue_id = v_document.venue_id
      and unit.is_active
  ) or not exists (
    select 1 from public.inventory_warehouses warehouse
    where warehouse.id = p_warehouse_id
      and warehouse.tenant_id = v_document.tenant_id
      and warehouse.venue_id = v_document.venue_id
      and warehouse.is_active
  ) then raise exception 'INVENTORY_ITEM_ROUTE_REQUIRED' using errcode = '22023'; end if;
  insert into public.inventory_items (
    id, tenant_id, venue_id, name, description, base_unit_id, reference_cost, is_active
  ) values (
    v_item_id, v_document.tenant_id, v_document.venue_id, btrim(p_name), '',
    p_base_unit_id, round(p_reference_cost, 6), true
  );
  insert into public.inventory_item_warehouse_routes (
    inventory_item_id, warehouse_id, tenant_id, venue_id, priority, is_enabled
  ) values (
    v_item_id, p_warehouse_id, v_document.tenant_id, v_document.venue_id, 1, true
  );
  insert into public.inventory_stock_levels (
    warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled
  ) values (
    p_warehouse_id, v_item_id, v_document.tenant_id, v_document.venue_id, 0, true
  );
  return v_item_id;
end;
$$;

-- Private low-level extension of the existing incremental stock mechanism used
-- by record_inventory_production. It locks, adds a delta and writes the same
-- inventory_stock_movements ledger; it is never granted to clients.
create or replace function public.increment_inventory_item_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_warehouse_id uuid,
  p_quantity numeric,
  p_source_type text,
  p_source_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_unit_id uuid;
  v_before numeric(18, 6);
  v_quantity numeric(18, 6) := round(coalesce(p_quantity, 0), 6);
begin
  if v_quantity <= 0 then
    raise exception 'INVENTORY_INVALID_QUANTITY' using errcode = '22023';
  end if;
  select item.base_unit_id into v_unit_id
  from public.inventory_items item
  where item.id = p_inventory_item_id
    and item.tenant_id = p_tenant_id
    and item.venue_id = p_venue_id
    and item.is_active;
  if v_unit_id is null then
    raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1
    from public.inventory_warehouses warehouse
    where warehouse.id = p_warehouse_id
      and warehouse.tenant_id = p_tenant_id
      and warehouse.venue_id = p_venue_id
      and warehouse.is_active
  ) then raise exception 'INVENTORY_WAREHOUSE_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.inventory_stock_levels (
    warehouse_id, inventory_item_id, tenant_id, venue_id, quantity, is_enabled
  ) values (
    p_warehouse_id, p_inventory_item_id, p_tenant_id, p_venue_id, 0, true
  ) on conflict (warehouse_id, inventory_item_id) do nothing;
  select level.quantity into v_before
  from public.inventory_stock_levels level
  where level.warehouse_id = p_warehouse_id
    and level.inventory_item_id = p_inventory_item_id
    and level.tenant_id = p_tenant_id
    and level.venue_id = p_venue_id
  for update;
  update public.inventory_stock_levels
  set quantity = quantity + v_quantity,
      is_enabled = true,
      updated_at = now()
  where warehouse_id = p_warehouse_id
    and inventory_item_id = p_inventory_item_id;
  insert into public.inventory_stock_movements (
    tenant_id, venue_id, warehouse_id, inventory_item_id,
    source_type, source_id, stock_quantity_delta, stock_quantity_before,
    stock_quantity_after, unit_id, metadata
  ) values (
    p_tenant_id, p_venue_id, p_warehouse_id, p_inventory_item_id,
    p_source_type, p_source_id, v_quantity, v_before, v_before + v_quantity,
    v_unit_id, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

create or replace function public.confirm_supplier_document(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_document public.supplier_documents%rowtype;
  v_line public.supplier_document_lines%rowtype;
  v_item public.inventory_items%rowtype;
  v_line_count integer := 0;
  v_correction_count integer := 0;
  v_alias_value text;
begin
  select document.* into v_document
  from public.supplier_documents document
  where document.id = p_document_id
  for update;
  if v_document.id is null then
    raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.user_is_tenant_admin(v_document.tenant_id)
    and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
  then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if v_document.status = 'confirmed' then
    return jsonb_build_object(
      'documentId', v_document.id,
      'confirmedAt', v_document.confirmed_at,
      'duplicate', true
    );
  end if;
  if v_document.status <> 'review' then
    raise exception 'SUPPLIER_DOCUMENT_NOT_READY' using errcode = '55000';
  end if;
  if v_document.supplier_id is null then
    raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_REQUIRED' using errcode = '22023';
  end if;
  if nullif(btrim(v_document.document_number), '') is not null and exists (
    select 1 from public.supplier_documents duplicate
    where duplicate.id <> v_document.id
      and duplicate.tenant_id = v_document.tenant_id
      and duplicate.venue_id = v_document.venue_id
      and duplicate.supplier_id = v_document.supplier_id
      and duplicate.document_type = v_document.document_type
      and lower(btrim(duplicate.document_number)) = lower(btrim(v_document.document_number))
      and duplicate.status = 'confirmed'
  ) then raise exception 'SUPPLIER_DOCUMENT_DUPLICATE_NUMBER' using errcode = '23505'; end if;
  for v_line in
    select line.*
    from public.supplier_document_lines line
    where line.supplier_document_id = v_document.id
      and line.tenant_id = v_document.tenant_id
      and line.venue_id = v_document.venue_id
    order by line.line_number
    for update
  loop
    v_line_count := v_line_count + 1;
    if v_line.inventory_item_id is null
      or v_line.warehouse_id is null
      or coalesce(v_line.base_quantity, 0) <= 0
      or coalesce(v_line.normalized_unit_cost, -1) < 0
      or v_line.match_status = 'needs_review'
    then
      raise exception 'SUPPLIER_DOCUMENT_LINE_UNRESOLVED line=%', v_line.line_number
        using errcode = '22023';
    end if;
    select item.* into v_item
    from public.inventory_items item
    where item.id = v_line.inventory_item_id
      and item.tenant_id = v_document.tenant_id
      and item.venue_id = v_document.venue_id
      and item.is_active;
    if v_item.id is null then
      raise exception 'SUPPLIER_DOCUMENT_ITEM_INVALID line=%', v_line.line_number
        using errcode = '22023';
    end if;
    if v_item.reference_cost is distinct from v_line.normalized_unit_cost
      and not v_line.reference_cost_decided
    then
      raise exception 'SUPPLIER_DOCUMENT_COST_DECISION_REQUIRED line=%', v_line.line_number
        using errcode = '22023';
    end if;
    perform public.increment_inventory_item_stock(
      v_document.tenant_id,
      v_document.venue_id,
      v_line.inventory_item_id,
      v_line.warehouse_id,
      v_line.base_quantity,
      'supplier_document_receipt',
      v_line.id,
      jsonb_build_object(
        'supplierDocumentId', v_document.id,
        'supplierId', v_document.supplier_id,
        'documentType', v_document.document_type,
        'documentNumber', v_document.document_number,
        'supplierReference', v_line.supplier_reference,
        'purchaseQuantity', v_line.quantity,
        'purchaseUnit', v_line.purchase_unit,
        'realNormalizedUnitCost', v_line.normalized_unit_cost
      )
    );
    if nullif(btrim(v_line.barcode), '') is not null then
      v_alias_value := regexp_replace(lower(btrim(v_line.barcode)), '[^0-9a-z]+', '', 'g');
      insert into public.supplier_item_aliases (
        tenant_id, venue_id, supplier_id, alias_type, alias_value,
        inventory_item_id, packaging_json
      ) values (
        v_document.tenant_id, v_document.venue_id, v_document.supplier_id,
        'ean', v_alias_value, v_line.inventory_item_id,
        jsonb_build_object('packageCount', v_line.package_count, 'unitQuantity', v_line.package_unit_quantity, 'unitSymbol', v_line.package_unit_symbol)
      ) on conflict (tenant_id, venue_id, supplier_id, alias_type, alias_value)
      do update set inventory_item_id = excluded.inventory_item_id,
        packaging_json = excluded.packaging_json,
        confirmation_count = public.supplier_item_aliases.confirmation_count + 1,
        last_confirmed_at = now(), updated_at = now();
    end if;
    if nullif(btrim(v_line.supplier_reference), '') is not null then
      v_alias_value := lower(btrim(v_line.supplier_reference));
      insert into public.supplier_item_aliases (
        tenant_id, venue_id, supplier_id, alias_type, alias_value,
        inventory_item_id, packaging_json
      ) values (
        v_document.tenant_id, v_document.venue_id, v_document.supplier_id,
        'supplier_reference', v_alias_value, v_line.inventory_item_id,
        jsonb_build_object('packageCount', v_line.package_count, 'unitQuantity', v_line.package_unit_quantity, 'unitSymbol', v_line.package_unit_symbol)
      ) on conflict (tenant_id, venue_id, supplier_id, alias_type, alias_value)
      do update set inventory_item_id = excluded.inventory_item_id,
        packaging_json = excluded.packaging_json,
        confirmation_count = public.supplier_item_aliases.confirmation_count + 1,
        last_confirmed_at = now(), updated_at = now();
    end if;
    if nullif(btrim(v_line.description_normalized), '') is not null then
      v_alias_value := lower(btrim(v_line.description_normalized));
      insert into public.supplier_item_aliases (
        tenant_id, venue_id, supplier_id, alias_type, alias_value,
        inventory_item_id, packaging_json
      ) values (
        v_document.tenant_id, v_document.venue_id, v_document.supplier_id,
        'description', v_alias_value, v_line.inventory_item_id,
        jsonb_build_object('packageCount', v_line.package_count, 'unitQuantity', v_line.package_unit_quantity, 'unitSymbol', v_line.package_unit_symbol)
      ) on conflict (tenant_id, venue_id, supplier_id, alias_type, alias_value)
      do update set inventory_item_id = excluded.inventory_item_id,
        packaging_json = excluded.packaging_json,
        confirmation_count = public.supplier_item_aliases.confirmation_count + 1,
        last_confirmed_at = now(), updated_at = now();
    end if;
    if v_line.update_reference_cost
      and v_item.reference_cost is distinct from v_line.normalized_unit_cost
    then
      insert into public.inventory_reference_cost_history (
        tenant_id, venue_id, inventory_item_id, supplier_document_id,
        supplier_document_line_id, previous_cost, new_cost, changed_by
      ) values (
        v_document.tenant_id, v_document.venue_id, v_line.inventory_item_id,
        v_document.id, v_line.id, v_item.reference_cost,
        v_line.normalized_unit_cost, auth.uid()
      );
      update public.inventory_items
      set reference_cost = v_line.normalized_unit_cost, updated_at = now()
      where id = v_line.inventory_item_id
        and tenant_id = v_document.tenant_id
        and venue_id = v_document.venue_id;
    end if;
    if v_line.was_corrected then
      v_correction_count := v_correction_count + 1;
    end if;
  end loop;
  if v_line_count = 0 then
    raise exception 'SUPPLIER_DOCUMENT_LINES_REQUIRED' using errcode = '22023';
  end if;
  if v_document.global_profile_id is not null then
    update public.global_supplier_document_profiles profile
    set success_count = profile.success_count + 1,
        correction_count = profile.correction_count + v_correction_count,
        status = case
          when profile.status = 'candidate'
            and profile.success_count + 1 >= 3
            and (profile.correction_count + v_correction_count)::numeric
              / greatest(profile.success_count + 1, 1) <= 0.15
          then 'verified'
          else profile.status
        end,
        updated_at = now()
    where profile.id = v_document.global_profile_id;
  end if;
  update public.supplier_documents
  set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), updated_at = now()
  where id = v_document.id;
  return jsonb_build_object(
    'documentId', v_document.id,
    'confirmedAt', now(),
    'lineCount', v_line_count,
    'duplicate', false
  );
end;
$$;

create trigger set_global_suppliers_updated_at
before update on public.global_suppliers
for each row execute function public.set_updated_at();
create trigger set_global_supplier_profiles_updated_at
before update on public.global_supplier_document_profiles
for each row execute function public.set_updated_at();
create trigger set_suppliers_updated_at
before update on public.suppliers
for each row execute function public.set_updated_at();
create trigger set_supplier_documents_updated_at
before update on public.supplier_documents
for each row execute function public.set_updated_at();
create trigger set_supplier_document_lines_updated_at
before update on public.supplier_document_lines
for each row execute function public.set_updated_at();
create trigger set_supplier_item_aliases_updated_at
before update on public.supplier_item_aliases
for each row execute function public.set_updated_at();

alter table public.global_suppliers enable row level security;
alter table public.global_supplier_document_profiles enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_documents enable row level security;
alter table public.supplier_document_lines enable row level security;
alter table public.supplier_item_aliases enable row level security;
alter table public.inventory_reference_cost_history enable row level security;

create policy global_suppliers_read on public.global_suppliers
for select to authenticated using (true);
create policy global_supplier_profiles_read on public.global_supplier_document_profiles
for select to authenticated using (true);
create policy suppliers_read on public.suppliers
for select to authenticated
using (public.user_is_tenant_admin(tenant_id));
create policy supplier_documents_read on public.supplier_documents
for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy supplier_document_lines_read on public.supplier_document_lines
for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy supplier_item_aliases_read on public.supplier_item_aliases
for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));
create policy inventory_reference_cost_history_read on public.inventory_reference_cost_history
for select to authenticated
using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id, venue_id));

revoke all on public.global_suppliers, public.global_supplier_document_profiles,
  public.suppliers, public.supplier_documents, public.supplier_document_lines,
  public.supplier_item_aliases, public.inventory_reference_cost_history
from public, anon, authenticated;

grant select on public.global_suppliers, public.global_supplier_document_profiles,
  public.suppliers, public.supplier_documents, public.supplier_document_lines,
  public.supplier_item_aliases, public.inventory_reference_cost_history
to authenticated;

revoke all on function public.can_access_supplier_document_object(text),
  public.increment_inventory_item_stock(uuid, uuid, uuid, uuid, numeric, text, uuid, jsonb)
from public, anon, authenticated;

grant execute on function public.can_access_supplier_document_object(text)
to authenticated;

revoke all on function public.create_supplier_document(uuid, text, text, text, text, text),
  public.save_supplier_document_line(uuid, uuid, uuid, uuid, numeric, text, numeric, numeric, text, numeric, numeric, numeric, numeric, boolean, boolean),
  public.create_inventory_item_from_supplier_document(uuid, text, uuid, uuid, numeric),
  public.confirm_supplier_document(uuid)
from public, anon, authenticated;

grant execute on function public.create_supplier_document(uuid, text, text, text, text, text),
  public.save_supplier_document_line(uuid, uuid, uuid, uuid, numeric, text, numeric, numeric, text, numeric, numeric, numeric, numeric, boolean, boolean),
  public.create_inventory_item_from_supplier_document(uuid, text, uuid, uuid, numeric),
  public.confirm_supplier_document(uuid)
to authenticated;

comment on table public.global_supplier_document_profiles is
  'Declarative OCR parsing knowledge only; never stores tenant prices, quantities, inventory IDs or stock.';
comment on table public.supplier_document_lines is
  'Tenant-private purchase history. Confirmed lines retain the real normalized purchase cost independently of reference_cost.';
comment on function public.confirm_supplier_document(uuid) is
  'Atomically validates a complete supplier receipt, increments stock, writes movements and aliases, applies accepted reference costs, and confirms once.';
