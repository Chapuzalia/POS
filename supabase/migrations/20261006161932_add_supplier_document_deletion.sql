-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE, REVOKE
-- migration-safety-reason: Keep existing addon/storage signatures and live-document behavior; freeze deleted documents and limit new deletion/cleanup RPCs to their intended callers.

-- Tombstones retain the FK-backed cost and stock history. No existing document
-- is changed by this migration. Identity keys are released only on explicit deletion.
alter table public.supplier_documents
  add column deleted_at timestamptz,
  add column storage_deleted_at timestamptz;

create policy supplier_documents_not_deleted on public.supplier_documents
  as restrictive for select to authenticated using (deleted_at is null);
create policy supplier_document_lines_not_deleted on public.supplier_document_lines
  as restrictive for select to authenticated using (exists (
    select 1 from public.supplier_documents document
    where document.id = supplier_document_id and document.deleted_at is null
  ));

create or replace function public.can_access_supplier_document_object(p_name text)
returns boolean language sql stable security definer set search_path to '' as $$
  select public.can_access_supplier_document_object_without_addon(p_name) and exists (
    select 1 from public.supplier_documents document where document.storage_path = p_name
      and document.deleted_at is null
      and public.supplier_documents_feature_enabled(document.tenant_id)
  );
$$;

create or replace function public.guard_supplier_document_addon_write()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_table_name = 'supplier_document_lines' then
    if exists (select 1 from public.supplier_documents document
      where document.id = coalesce(new.supplier_document_id, old.supplier_document_id)
        and document.deleted_at is not null) then
      raise exception 'SUPPLIER_DOCUMENT_DELETED' using errcode = '55000';
    end if;
    perform public.assert_supplier_document_scanning(coalesce(new.supplier_document_id, old.supplier_document_id));
  else
    if tg_op = 'UPDATE' and new.processing_mode <> old.processing_mode then
      raise exception 'SUPPLIER_DOCUMENT_MODE_IMMUTABLE' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and old.deleted_at is not null then
      if (to_jsonb(new) - 'storage_deleted_at' - 'updated_at')
        is distinct from (to_jsonb(old) - 'storage_deleted_at' - 'updated_at') then
        raise exception 'SUPPLIER_DOCUMENT_DELETED' using errcode = '55000';
      end if;
      return new;
    end if;
    -- Deletion remains available with the purchases addon even when scanning
    -- is disabled. The new RPC validates auth, tenant and venue before this write.
    if tg_op = 'UPDATE' and new.deleted_at is not null then return new; end if;
    if not public.supplier_documents_feature_enabled(new.tenant_id, new.processing_mode = 'scan') then
      raise exception 'SUPPLIER_DOCUMENT_ADDON_DISABLED' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger guard_supplier_document_lines_deleted before delete on public.supplier_document_lines
  for each row execute function public.guard_supplier_document_addon_write();

create function public.guard_supplier_document_link_deletion()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_document record;
begin
  for v_document in select id, deleted_at from public.supplier_documents
    where id in (new.invoice_document_id, new.delivery_note_document_id)
      and tenant_id = new.tenant_id and venue_id = new.venue_id order by id for share
  loop
    if v_document.deleted_at is not null then
      raise exception 'SUPPLIER_DOCUMENT_DELETED' using errcode = '55000';
    end if;
  end loop;
  return new;
end;
$$;
create trigger guard_supplier_document_link_deletion before insert or update on public.supplier_document_links
  for each row execute function public.guard_supplier_document_link_deletion();

create function public.delete_supplier_document(
  p_document_id uuid, p_venue_id uuid, p_tenant_id uuid, p_reverse_stock boolean default null
)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_tenant_id uuid;
  v_document public.supplier_documents%rowtype;
  v_movement record;
  v_links jsonb;
  v_reversed boolean := false;
begin
  if auth.uid() is null then
    raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501';
  end if;
  v_tenant_id := public.assert_supplier_document_venue(p_venue_id, false);
  if v_tenant_id is distinct from p_tenant_id then
    raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_document from public.supplier_documents
    where id = p_document_id and tenant_id = v_tenant_id and venue_id = p_venue_id for update;
  if v_document.id is null then
    raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_document.deleted_at is null then
    if v_document.stock_applied_at is not null and p_reverse_stock is null then
      raise exception 'SUPPLIER_DOCUMENT_STOCK_CHOICE_REQUIRED' using errcode = '22023';
    end if;
    if coalesce(p_reverse_stock, false) and v_document.stock_applied_at is not null then
      -- Reverse actual receipts plus their corrections, including reassignment
      -- between items/warehouses. Never use current catalogue quantities/costs.
      for v_movement in
        select movement.source_id, movement.inventory_item_id, movement.warehouse_id,
          sum(movement.stock_quantity_delta) as quantity
        from public.inventory_stock_movements movement
        join public.supplier_document_lines line on line.id = movement.source_id
          and line.tenant_id = movement.tenant_id and line.venue_id = movement.venue_id
        where line.supplier_document_id = v_document.id
          and movement.tenant_id = v_tenant_id and movement.venue_id = p_venue_id
          and movement.source_type in ('supplier_document_receipt', 'supplier_document_correction')
        group by movement.source_id, movement.inventory_item_id, movement.warehouse_id
        having sum(movement.stock_quantity_delta) <> 0
        order by movement.inventory_item_id, movement.warehouse_id, movement.source_id
      loop
        perform public.adjust_inventory_item_stock(
          v_tenant_id, p_venue_id, v_movement.inventory_item_id, v_movement.warehouse_id,
          -v_movement.quantity, 'supplier_document_correction', v_movement.source_id,
          jsonb_build_object('supplierDocumentId', v_document.id, 'reason', 'document_deletion', 'deletedBy', auth.uid())
        );
        v_reversed := true;
      end loop;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('invoiceDocumentId', invoice_document_id,
      'deliveryNoteDocumentId', delivery_note_document_id)), '[]'::jsonb) into v_links
    from public.supplier_document_links
    where tenant_id = v_tenant_id and venue_id = p_venue_id
      and (invoice_document_id = v_document.id or delivery_note_document_id = v_document.id);
    delete from public.supplier_document_links
    where tenant_id = v_tenant_id and venue_id = p_venue_id
      and (invoice_document_id = v_document.id or delivery_note_document_id = v_document.id);
    update public.supplier_documents
    set deleted_at = now(), file_hash = null, document_number = null,
      extraction_metadata = extraction_metadata || jsonb_build_object('deletion', jsonb_build_object(
        'deletedBy', auth.uid(), 'deletedAt', now(), 'reverseStockRequested', coalesce(p_reverse_stock, false),
        'stockReversed', v_reversed, 'documentNumber', v_document.document_number,
        'fileHash', v_document.file_hash, 'links', v_links)), updated_at = now()
    where id = v_document.id returning * into v_document;
  end if;
  return jsonb_build_object('documentId', v_document.id,
    'storageBucket', v_document.storage_bucket, 'storagePath', v_document.storage_path,
    'storageDeleted', v_document.storage_deleted_at is not null,
    'stockReversed', coalesce((v_document.extraction_metadata -> 'deletion' ->> 'stockReversed')::boolean, false));
end;
$$;

-- Only the trusted Edge cleanup may mark the exact already-deleted document.
create function public.finish_supplier_document_deletion(p_document_id uuid)
returns void language sql security definer set search_path to '' as $$
  update public.supplier_documents set storage_deleted_at = now(), updated_at = now()
  where id = p_document_id and deleted_at is not null and storage_deleted_at is null;
$$;

revoke all on function public.delete_supplier_document(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.delete_supplier_document(uuid, uuid, uuid, boolean) to authenticated;
revoke all on function public.finish_supplier_document_deletion(uuid) from public, anon, authenticated;
grant execute on function public.finish_supplier_document_deletion(uuid) to service_role;

comment on function public.delete_supplier_document(uuid, uuid, uuid, boolean) is
  'Deletes a scoped purchase document from active use; optionally appends stock reversals and preserves cost/movement history. Idempotent for retries.';
