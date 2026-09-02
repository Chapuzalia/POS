-- Purchase management V1 extends supplier documents; it deliberately does not
-- introduce a second purchase/expense ledger.

alter table public.inventory_items
  add column if not exists last_purchase_cost numeric(18, 6),
  add column if not exists average_cost numeric(18, 6);

alter table public.inventory_items
  drop constraint if exists inventory_items_last_purchase_cost_check,
  add constraint inventory_items_last_purchase_cost_check
    check (last_purchase_cost is null or last_purchase_cost >= 0),
  drop constraint if exists inventory_items_average_cost_check,
  add constraint inventory_items_average_cost_check
    check (average_cost is null or average_cost >= 0);

alter table public.supplier_documents
  add column if not exists affects_stock boolean not null default true,
  add column if not exists stock_applied_at timestamptz;

alter table public.supplier_documents
  drop constraint if exists supplier_documents_stock_application_check,
  add constraint supplier_documents_stock_application_check check (
    stock_applied_at is null or (status = 'confirmed' and affects_stock)
  );

-- Every confirmed document that predates this migration necessarily used the
-- old confirmation RPC, which always applied stock.
update public.supplier_documents
set stock_applied_at = confirmed_at
where status = 'confirmed' and stock_applied_at is null;

create index if not exists supplier_documents_purchase_period_idx
  on public.supplier_documents (tenant_id, venue_id, document_date desc, document_type, status);
create index if not exists supplier_document_lines_purchase_item_idx
  on public.supplier_document_lines
    (tenant_id, venue_id, inventory_item_id, supplier_document_id)
  where inventory_item_id is not null;

create table public.supplier_document_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  invoice_document_id uuid not null,
  delivery_note_document_id uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint supplier_document_links_scope_unique unique (id, tenant_id, venue_id),
  constraint supplier_document_links_pair_unique
    unique (invoice_document_id, delivery_note_document_id),
  constraint supplier_document_links_delivery_unique
    unique (delivery_note_document_id),
  constraint supplier_document_links_distinct_check
    check (invoice_document_id <> delivery_note_document_id),
  constraint supplier_document_links_invoice_scope_fk
    foreign key (invoice_document_id, tenant_id, venue_id)
    references public.supplier_documents(id, tenant_id, venue_id) on delete cascade,
  constraint supplier_document_links_delivery_scope_fk
    foreign key (delivery_note_document_id, tenant_id, venue_id)
    references public.supplier_documents(id, tenant_id, venue_id) on delete cascade
);

create index supplier_document_links_delivery_idx
  on public.supplier_document_links (tenant_id, venue_id, delivery_note_document_id);

alter table public.supplier_document_links enable row level security;

create policy supplier_document_links_read on public.supplier_document_links
for select to authenticated
using (
  (select public.user_is_tenant_admin(tenant_id))
  or (select public.user_has_venue_access(tenant_id, venue_id))
);

revoke all on public.supplier_document_links from public, anon, authenticated;
grant select on public.supplier_document_links to authenticated;

-- This private helper is the signed-delta equivalent of the original receipt
-- helper. It is used by corrections so historical movements are appended,
-- never deleted or rewritten.
create or replace function public.adjust_inventory_item_stock(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_warehouse_id uuid,
  p_quantity_delta numeric,
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
  v_delta numeric(18, 6) := round(coalesce(p_quantity_delta, 0), 6);
begin
  if v_delta = 0 then return; end if;
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
    select 1 from public.inventory_warehouses warehouse
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
  set quantity = quantity + v_delta, is_enabled = true, updated_at = now()
  where warehouse_id = p_warehouse_id and inventory_item_id = p_inventory_item_id;
  insert into public.inventory_stock_movements (
    tenant_id, venue_id, warehouse_id, inventory_item_id,
    source_type, source_id, stock_quantity_delta, stock_quantity_before,
    stock_quantity_after, unit_id, metadata
  ) values (
    p_tenant_id, p_venue_id, p_warehouse_id, p_inventory_item_id,
    p_source_type, p_source_id, v_delta, v_before, v_before + v_delta,
    v_unit_id, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.adjust_inventory_item_stock(
  uuid, uuid, uuid, uuid, numeric, text, uuid, jsonb
) from public, anon, authenticated;

create or replace function public.apply_inventory_average_cost_entry(
  p_tenant_id uuid,
  p_venue_id uuid,
  p_inventory_item_id uuid,
  p_quantity numeric,
  p_unit_cost numeric
)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item public.inventory_items%rowtype;
  v_current_quantity numeric(18, 6);
begin
  if coalesce(p_quantity, 0) <= 0 or coalesce(p_unit_cost, -1) < 0 then
    raise exception 'INVENTORY_AVERAGE_COST_ENTRY_INVALID' using errcode = '22023';
  end if;
  select item.* into v_item from public.inventory_items item
  where item.id = p_inventory_item_id and item.tenant_id = p_tenant_id
    and item.venue_id = p_venue_id for update;
  if v_item.id is null then raise exception 'INVENTORY_ITEM_NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(sum(level.quantity), 0) into v_current_quantity
  from public.inventory_stock_levels level
  where level.inventory_item_id = v_item.id and level.tenant_id = p_tenant_id and level.venue_id = p_venue_id;
  update public.inventory_items set average_cost = round(
    ((coalesce(v_item.average_cost, v_item.last_purchase_cost, v_item.reference_cost, p_unit_cost) * greatest(v_current_quantity, 0))
      + (p_unit_cost * p_quantity))
    / nullif(greatest(v_current_quantity, 0) + p_quantity, 0), 6
  ), updated_at = now()
  where id = v_item.id;
end;
$$;

revoke all on function public.apply_inventory_average_cost_entry(uuid, uuid, uuid, numeric, numeric)
from public, anon, authenticated;

drop function if exists public.confirm_supplier_document(uuid);

create function public.confirm_supplier_document(
  p_document_id uuid,
  p_document_date date,
  p_affects_stock boolean,
  p_delivery_note_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_document public.supplier_documents%rowtype;
  v_line public.supplier_document_lines%rowtype;
  v_item public.inventory_items%rowtype;
  v_delivery_note_id uuid;
  v_line_count integer := 0;
  v_correction_count integer := 0;
  v_alias_value text;
  v_alias_type text;
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
      'documentId', v_document.id, 'confirmedAt', v_document.confirmed_at,
      'affectsStock', v_document.affects_stock, 'duplicate', true
    );
  end if;
  if v_document.status <> 'review' then
    raise exception 'SUPPLIER_DOCUMENT_NOT_READY' using errcode = '55000';
  end if;
  if p_document_date is null then
    raise exception 'SUPPLIER_DOCUMENT_DATE_REQUIRED' using errcode = '22023';
  end if;
  if v_document.supplier_id is null then
    raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_REQUIRED' using errcode = '22023';
  end if;
  if coalesce(array_length(p_delivery_note_ids, 1), 0) > 0
     and v_document.document_type <> 'invoice' then
    raise exception 'SUPPLIER_DOCUMENT_LINKS_REQUIRE_INVOICE' using errcode = '22023';
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

  foreach v_delivery_note_id in array coalesce(p_delivery_note_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from public.supplier_documents note
      where note.id = v_delivery_note_id
        and note.tenant_id = v_document.tenant_id
        and note.venue_id = v_document.venue_id
        and note.document_type = 'delivery_note'
        and note.status = 'confirmed'
    ) then raise exception 'SUPPLIER_DELIVERY_NOTE_INVALID' using errcode = '22023'; end if;
    if exists (
      select 1 from public.supplier_document_links link
      where link.delivery_note_document_id = v_delivery_note_id
        and link.invoice_document_id <> v_document.id
    ) then raise exception 'SUPPLIER_DELIVERY_NOTE_ALREADY_LINKED' using errcode = '23505'; end if;
  end loop;

  for v_line in
    select line.* from public.supplier_document_lines line
    where line.supplier_document_id = v_document.id
      and line.tenant_id = v_document.tenant_id
      and line.venue_id = v_document.venue_id
    order by line.line_number for update
  loop
    v_line_count := v_line_count + 1;
    if coalesce(v_line.quantity, 0) <= 0
      or coalesce(v_line.line_total, v_line.net_cost, -1) < 0
    then raise exception 'SUPPLIER_DOCUMENT_LINE_INVALID line=%', v_line.line_number using errcode = '22023'; end if;
    if coalesce(p_affects_stock, true) and (
      v_line.inventory_item_id is null or v_line.warehouse_id is null
      or coalesce(v_line.base_quantity, 0) <= 0
      or coalesce(v_line.normalized_unit_cost, -1) < 0
      or v_line.match_status = 'needs_review'
    ) then raise exception 'SUPPLIER_DOCUMENT_LINE_UNRESOLVED line=%', v_line.line_number using errcode = '22023'; end if;

    if v_line.inventory_item_id is not null then
      select item.* into v_item from public.inventory_items item
      where item.id = v_line.inventory_item_id
        and item.tenant_id = v_document.tenant_id
        and item.venue_id = v_document.venue_id and item.is_active
      for update;
      if v_item.id is null then
        raise exception 'SUPPLIER_DOCUMENT_ITEM_INVALID line=%', v_line.line_number using errcode = '22023';
      end if;
      if v_line.normalized_unit_cost is not null
        and v_item.reference_cost is distinct from v_line.normalized_unit_cost
        and not v_line.reference_cost_decided
      then raise exception 'SUPPLIER_DOCUMENT_COST_DECISION_REQUIRED line=%', v_line.line_number using errcode = '22023'; end if;
      if v_line.normalized_unit_cost is not null then
        update public.inventory_items
        set last_purchase_cost = v_line.normalized_unit_cost, updated_at = now()
        where id = v_item.id;
      end if;
      if coalesce(p_affects_stock, true) then
        perform public.apply_inventory_average_cost_entry(
          v_document.tenant_id, v_document.venue_id, v_item.id,
          v_line.base_quantity, v_line.normalized_unit_cost
        );
        perform public.increment_inventory_item_stock(
          v_document.tenant_id, v_document.venue_id, v_line.inventory_item_id,
          v_line.warehouse_id, v_line.base_quantity, 'supplier_document_receipt',
          v_line.id, jsonb_build_object(
            'supplierDocumentId', v_document.id, 'supplierId', v_document.supplier_id,
            'documentDate', p_document_date, 'documentType', v_document.document_type,
            'documentNumber', v_document.document_number,
            'realNormalizedUnitCost', v_line.normalized_unit_cost
          )
        );
      end if;
      if v_line.update_reference_cost and v_line.normalized_unit_cost is not null
        and v_item.reference_cost is distinct from v_line.normalized_unit_cost
      then
        insert into public.inventory_reference_cost_history (
          tenant_id, venue_id, inventory_item_id, supplier_document_id,
          supplier_document_line_id, previous_cost, new_cost, changed_by
        ) values (
          v_document.tenant_id, v_document.venue_id, v_line.inventory_item_id,
          v_document.id, v_line.id, v_item.reference_cost, v_line.normalized_unit_cost, auth.uid()
        );
        update public.inventory_items set reference_cost = v_line.normalized_unit_cost, updated_at = now()
        where id = v_line.inventory_item_id;
      end if;
      for v_alias_type, v_alias_value in
        select candidate.alias_type, candidate.alias_value
        from (values
          ('ean'::text, regexp_replace(lower(btrim(v_line.barcode)), '[^0-9a-z]+', '', 'g')),
          ('supplier_reference'::text, lower(btrim(v_line.supplier_reference))),
          ('description'::text, lower(btrim(v_line.description_normalized)))
        ) candidate(alias_type, alias_value)
        where nullif(candidate.alias_value, '') is not null
      loop
        insert into public.supplier_item_aliases (
          tenant_id, venue_id, supplier_id, alias_type, alias_value, inventory_item_id, packaging_json
        ) values (
          v_document.tenant_id, v_document.venue_id, v_document.supplier_id,
          v_alias_type, v_alias_value, v_line.inventory_item_id,
          jsonb_build_object('packageCount', v_line.package_count, 'unitQuantity', v_line.package_unit_quantity, 'unitSymbol', v_line.package_unit_symbol)
        ) on conflict (tenant_id, venue_id, supplier_id, alias_type, alias_value)
        do update set inventory_item_id = excluded.inventory_item_id,
          packaging_json = excluded.packaging_json,
          confirmation_count = public.supplier_item_aliases.confirmation_count + 1,
          last_confirmed_at = now(), updated_at = now();
      end loop;
    end if;
    if v_line.was_corrected then v_correction_count := v_correction_count + 1; end if;
  end loop;
  if v_line_count = 0 then
    raise exception 'SUPPLIER_DOCUMENT_LINES_REQUIRED' using errcode = '22023';
  end if;

  foreach v_delivery_note_id in array coalesce(p_delivery_note_ids, '{}'::uuid[]) loop
    insert into public.supplier_document_links (
      tenant_id, venue_id, invoice_document_id, delivery_note_document_id, created_by
    ) values (
      v_document.tenant_id, v_document.venue_id, v_document.id, v_delivery_note_id, auth.uid()
    ) on conflict (invoice_document_id, delivery_note_document_id) do nothing;
  end loop;

  if v_document.global_profile_id is not null then
    update public.global_supplier_document_profiles profile
    set success_count = profile.success_count + 1,
        correction_count = profile.correction_count + v_correction_count,
        updated_at = now()
    where profile.id = v_document.global_profile_id;
  end if;
  update public.supplier_documents
  set document_date = p_document_date,
      affects_stock = coalesce(p_affects_stock, true),
      stock_applied_at = case when coalesce(p_affects_stock, true) then now() else null end,
      status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), updated_at = now()
  where id = v_document.id;
  return jsonb_build_object(
    'documentId', v_document.id, 'confirmedAt', now(), 'lineCount', v_line_count,
    'affectsStock', coalesce(p_affects_stock, true), 'duplicate', false
  );
end;
$$;

revoke all on function public.confirm_supplier_document(uuid, date, boolean, uuid[])
from public, anon, authenticated;
grant execute on function public.confirm_supplier_document(uuid, date, boolean, uuid[])
to authenticated;

create function public.correct_supplier_document_line(
  p_document_id uuid,
  p_line_id uuid,
  p_inventory_item_id uuid,
  p_warehouse_id uuid,
  p_base_quantity numeric,
  p_normalized_unit_cost numeric,
  p_apply_stock boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_document public.supplier_documents%rowtype;
  v_line public.supplier_document_lines%rowtype;
  v_stock_was_applied boolean;
begin
  select document.* into v_document from public.supplier_documents document
  where document.id = p_document_id for update;
  if v_document.id is null or v_document.status <> 'confirmed' then
    raise exception 'SUPPLIER_DOCUMENT_CONFIRMED_REQUIRED' using errcode = '55000';
  end if;
  if not public.user_is_tenant_admin(v_document.tenant_id)
    and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
  then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  select line.* into v_line from public.supplier_document_lines line
  where line.id = p_line_id and line.supplier_document_id = v_document.id
    and line.tenant_id = v_document.tenant_id and line.venue_id = v_document.venue_id
  for update;
  if v_line.id is null then raise exception 'SUPPLIER_DOCUMENT_LINE_NOT_FOUND' using errcode = 'P0002'; end if;
  if p_inventory_item_id is null or p_warehouse_id is null
    or coalesce(p_base_quantity, 0) <= 0 or coalesce(p_normalized_unit_cost, -1) < 0
  then raise exception 'SUPPLIER_DOCUMENT_LINE_UNRESOLVED' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.inventory_items item where item.id = p_inventory_item_id
      and item.tenant_id = v_document.tenant_id and item.venue_id = v_document.venue_id and item.is_active
  ) then raise exception 'SUPPLIER_DOCUMENT_ITEM_INVALID' using errcode = '22023'; end if;

  v_stock_was_applied := v_document.stock_applied_at is not null;
  if v_stock_was_applied then
    if v_line.inventory_item_id = p_inventory_item_id and v_line.warehouse_id = p_warehouse_id then
      if p_base_quantity > coalesce(v_line.base_quantity, 0) then
        perform public.apply_inventory_average_cost_entry(
          v_document.tenant_id, v_document.venue_id, p_inventory_item_id,
          p_base_quantity - coalesce(v_line.base_quantity, 0), p_normalized_unit_cost
        );
      end if;
      perform public.adjust_inventory_item_stock(
        v_document.tenant_id, v_document.venue_id, p_inventory_item_id, p_warehouse_id,
        p_base_quantity - coalesce(v_line.base_quantity, 0), 'supplier_document_correction',
        v_line.id, jsonb_build_object('supplierDocumentId', v_document.id, 'reason', 'quantity_correction')
      );
    else
      perform public.adjust_inventory_item_stock(
        v_document.tenant_id, v_document.venue_id, v_line.inventory_item_id, v_line.warehouse_id,
        -v_line.base_quantity, 'supplier_document_correction', v_line.id,
        jsonb_build_object('supplierDocumentId', v_document.id, 'reason', 'item_reassignment_out')
      );
      perform public.apply_inventory_average_cost_entry(
        v_document.tenant_id, v_document.venue_id, p_inventory_item_id,
        p_base_quantity, p_normalized_unit_cost
      );
      perform public.adjust_inventory_item_stock(
        v_document.tenant_id, v_document.venue_id, p_inventory_item_id, p_warehouse_id,
        p_base_quantity, 'supplier_document_correction', v_line.id,
        jsonb_build_object('supplierDocumentId', v_document.id, 'reason', 'item_reassignment_in')
      );
    end if;
  elsif coalesce(p_apply_stock, false) then
    perform public.apply_inventory_average_cost_entry(
      v_document.tenant_id, v_document.venue_id, p_inventory_item_id,
      p_base_quantity, p_normalized_unit_cost
    );
    perform public.adjust_inventory_item_stock(
      v_document.tenant_id, v_document.venue_id, p_inventory_item_id, p_warehouse_id,
      p_base_quantity, 'supplier_document_correction', v_line.id,
      jsonb_build_object('supplierDocumentId', v_document.id, 'reason', 'explicit_stock_application')
    );
    update public.supplier_documents set affects_stock = true, stock_applied_at = now(), updated_at = now()
    where id = v_document.id;
  end if;

  update public.supplier_document_lines set
    inventory_item_id = p_inventory_item_id, warehouse_id = p_warehouse_id,
    base_quantity = round(p_base_quantity, 6), normalized_unit_cost = round(p_normalized_unit_cost, 6),
    match_status = 'recognized', was_corrected = true, updated_at = now()
  where id = v_line.id;
  update public.inventory_items set last_purchase_cost = round(p_normalized_unit_cost, 6), updated_at = now()
  where id = p_inventory_item_id and tenant_id = v_document.tenant_id and venue_id = v_document.venue_id;
  return jsonb_build_object('documentId', v_document.id, 'lineId', v_line.id, 'stockAdjusted', v_stock_was_applied or coalesce(p_apply_stock, false));
end;
$$;

revoke all on function public.correct_supplier_document_line(uuid, uuid, uuid, uuid, numeric, numeric, boolean)
from public, anon, authenticated;
grant execute on function public.correct_supplier_document_line(uuid, uuid, uuid, uuid, numeric, numeric, boolean)
to authenticated;

comment on table public.supplier_document_links is
  'Manual invoice-to-delivery-note links. The invoice is the economic source and linked delivery notes are excluded from purchase totals.';
comment on function public.confirm_supplier_document(uuid, date, boolean, uuid[]) is
  'Atomically confirms a supplier purchase, persists its real date and stock decision, optionally applies stock/costs, and links delivery notes exactly once.';
comment on function public.correct_supplier_document_line(uuid, uuid, uuid, uuid, numeric, numeric, boolean) is
  'Appends signed stock correction movements for confirmed supplier documents; stock-free documents remain stock-free unless explicitly requested.';
