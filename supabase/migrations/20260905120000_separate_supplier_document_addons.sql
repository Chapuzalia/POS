-- Stock keeps its existing assignments. Neither new addon is backfilled.
insert into public.platform_features (key, name, description, is_core, is_active, enabled_by_default, sort_order)
values
  ('supplier_documents', 'Archivo de documentos', 'Archivo manual de facturas y albaranes: subir, consultar y descargar originales. Sin OCR ni cambios de costes o stock.', false, true, false, 170),
  ('supplier_document_scanning', 'Escaneo de facturas y albaranes', 'Extrae líneas, calcula costes y permite entradas de stock tras revisión. Requiere Archivo de documentos y Gestión de stock.', false, true, false, 180)
on conflict (key) do update set name = excluded.name, description = excluded.description,
  is_core = false, is_active = true, enabled_by_default = false, sort_order = excluded.sort_order, updated_at = now();

update public.platform_features set name = 'Gestión de stock',
  description = 'Control de existencias, artículos, almacenes y movimientos manuales. El archivo y el escaneo de documentos se activan por separado.'
where key = 'inventory';

alter table public.supplier_documents
  add column processing_mode text not null default 'scan'
    check (processing_mode in ('archive', 'scan'));
-- Existing documents and their stock history are preserved as scan documents.
alter table public.supplier_documents add constraint supplier_documents_archive_no_stock
  check (processing_mode <> 'archive' or (not affects_stock and stock_applied_at is null));

create function public.supplier_documents_feature_enabled(p_tenant_id uuid, p_scanning boolean default false)
returns boolean language sql stable security definer set search_path to '' as $$
  select not exists (
    select 1 from unnest(case when p_scanning
      then array['supplier_documents', 'supplier_document_scanning', 'inventory']
      else array['supplier_documents'] end) required(key)
    where not exists (
      select 1 from public.tenant_feature_assignments assignment
      join public.platform_features feature on feature.key = assignment.feature_key and feature.is_active
      where assignment.tenant_id = p_tenant_id and assignment.feature_key = required.key
    )
  );
$$;

create function public.assert_supplier_document_venue(p_venue_id uuid, p_scanning boolean)
returns uuid language plpgsql security definer set search_path to '' as $$
declare v_tenant_id uuid;
begin
  select tenant_id into v_tenant_id from public.venues where id = p_venue_id and is_active;
  if v_tenant_id is null or auth.uid() is null or not (
    public.user_is_tenant_admin(v_tenant_id) or public.user_has_venue_access(v_tenant_id, p_venue_id)
  ) then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if not public.supplier_documents_feature_enabled(v_tenant_id, p_scanning) then
    raise exception 'SUPPLIER_DOCUMENT_ADDON_DISABLED' using errcode = '42501';
  end if;
  return v_tenant_id;
end;
$$;

create function public.assert_supplier_document_scanning(p_document_id uuid)
returns void language plpgsql security definer set search_path to '' as $$
declare v_document public.supplier_documents%rowtype;
begin
  select * into v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.id is null or not (
    coalesce(auth.role() = 'service_role', false) or (auth.uid() is not null and (
      public.user_is_tenant_admin(v_document.tenant_id)
      or public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
    ))
  ) then raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
  if v_document.processing_mode <> 'scan'
    or not public.supplier_documents_feature_enabled(v_document.tenant_id, true) then
    raise exception 'SUPPLIER_DOCUMENT_SCANNING_DISABLED' using errcode = '42501';
  end if;
end;
$$;

-- Restrictive policies supplement existing tenant/venue access policies.
create policy supplier_documents_addon on public.supplier_documents as restrictive for select to authenticated
  using (public.supplier_documents_feature_enabled(tenant_id));
create policy supplier_document_lines_addon on public.supplier_document_lines as restrictive for select to authenticated
  using (public.supplier_documents_feature_enabled(tenant_id, true));
create policy supplier_document_links_addon on public.supplier_document_links as restrictive for select to authenticated
  using (public.supplier_documents_feature_enabled(tenant_id, true));
create policy suppliers_document_addon on public.suppliers as restrictive for select to authenticated
  using (public.supplier_documents_feature_enabled(tenant_id));
create policy supplier_item_aliases_addon on public.supplier_item_aliases as restrictive for select to authenticated
  using (public.supplier_documents_feature_enabled(tenant_id, true));

alter function public.can_access_supplier_document_object(text) rename to can_access_supplier_document_object_without_addon;
create function public.can_access_supplier_document_object(p_name text)
returns boolean language sql stable security definer set search_path to '' as $$
  select public.can_access_supplier_document_object_without_addon(p_name) and exists (
    select 1 from public.supplier_documents document where document.storage_path = p_name
      and public.supplier_documents_feature_enabled(document.tenant_id)
  );
$$;
-- Policies retain references to the old function OID after a rename.
alter policy supplier_documents_storage_read on storage.objects
  using (bucket_id = 'supplier-documents' and public.can_access_supplier_document_object(name));
alter policy supplier_documents_storage_insert on storage.objects
  with check (bucket_id = 'supplier-documents' and public.can_access_supplier_document_object(name));
alter policy supplier_documents_storage_delete on storage.objects
  using (bucket_id = 'supplier-documents' and public.can_access_supplier_document_object(name));

-- Also guard in-flight Edge writes if an addon is revoked during processing.
create function public.guard_supplier_document_addon_write()
returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_table_name = 'supplier_document_lines' then
    perform public.assert_supplier_document_scanning(coalesce(new.supplier_document_id, old.supplier_document_id));
  else
    if tg_op = 'UPDATE' and new.processing_mode <> old.processing_mode then
      raise exception 'SUPPLIER_DOCUMENT_MODE_IMMUTABLE' using errcode = '42501';
    end if;
    if not public.supplier_documents_feature_enabled(new.tenant_id, new.processing_mode = 'scan') then
      raise exception 'SUPPLIER_DOCUMENT_ADDON_DISABLED' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
create trigger guard_supplier_document_addon before insert or update on public.supplier_documents
  for each row execute function public.guard_supplier_document_addon_write();
create trigger guard_supplier_document_lines_addon before insert or update on public.supplier_document_lines
  for each row execute function public.guard_supplier_document_addon_write();

-- Manual archive: metadata and originals only, with no extracted lines or stock/cost calls.
create function public.create_supplier_document_archive(
  p_venue_id uuid, p_document_type text, p_original_file_name text,
  p_original_mime_type text, p_file_hash text
)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_tenant_id uuid; v_document public.supplier_documents%rowtype; v_id uuid := gen_random_uuid(); v_path text;
begin
  v_tenant_id := public.assert_supplier_document_venue(p_venue_id, false);
  if p_document_type is null or p_document_type not in ('invoice', 'delivery_note')
    or nullif(btrim(p_original_file_name), '') is null or p_file_hash is null or p_file_hash !~ '^[a-fA-F0-9]{64}$' then
    raise exception 'SUPPLIER_DOCUMENT_INVALID_FILE' using errcode = '22023';
  end if;
  -- Serialize duplicate uploads for this venue/hash.
  perform pg_advisory_xact_lock(hashtextextended(p_venue_id::text || lower(p_file_hash), 0));
  select * into v_document from public.supplier_documents
    where tenant_id = v_tenant_id and venue_id = p_venue_id and lower(file_hash) = lower(p_file_hash);
  if v_document.id is not null then
    if v_document.processing_mode <> 'archive' then
      raise exception 'Este fichero ya existe como documento escaneado.' using errcode = '22023';
    end if;
    return jsonb_build_object('documentId', v_document.id, 'storageBucket', v_document.storage_bucket,
      'storagePath', v_document.storage_path, 'duplicate', true);
  end if;
  v_path := v_tenant_id || '/' || p_venue_id || '/' || v_id || '/' ||
    left(regexp_replace(p_original_file_name, '[^a-zA-Z0-9._-]+', '_', 'g'), 180);
  insert into public.supplier_documents (id, tenant_id, venue_id, document_type, processing_mode,
    affects_stock, status, storage_bucket, storage_path, original_file_name, original_mime_type, file_hash, created_by)
  values (v_id, v_tenant_id, p_venue_id, p_document_type, 'archive', false, 'review',
    'supplier-documents', v_path, p_original_file_name, p_original_mime_type, lower(p_file_hash), auth.uid());
  return jsonb_build_object('documentId', v_id, 'storageBucket', 'supplier-documents', 'storagePath', v_path, 'duplicate', false);
end;
$$;

create function public.save_supplier_document_archive(
  p_document_id uuid, p_supplier_id uuid, p_document_date date, p_document_number text
)
returns void language plpgsql security definer set search_path to '' as $$
declare v_document public.supplier_documents%rowtype;
begin
  select * into v_document from public.supplier_documents where id = p_document_id for update;
  if v_document.id is null then raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform public.assert_supplier_document_venue(v_document.venue_id, false);
  if v_document.processing_mode <> 'archive' then
    raise exception 'SUPPLIER_DOCUMENT_ARCHIVE_ONLY' using errcode = '42501';
  end if;
  if p_document_date is null or char_length(p_document_number) > 80 then
    raise exception 'Indica una fecha válida y un número de hasta 80 caracteres.' using errcode = '22023';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers where id = p_supplier_id and tenant_id = v_document.tenant_id and venue_id = v_document.venue_id
  ) then raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from storage.objects where bucket_id = v_document.storage_bucket and name = v_document.storage_path) then
    raise exception 'El fichero original todavía no se ha subido. Vuelve a seleccionarlo.' using errcode = '55000';
  end if;
  update public.supplier_documents set supplier_id = p_supplier_id, document_date = p_document_date,
    document_number = nullif(btrim(p_document_number), ''), status = 'confirmed',
    confirmed_at = coalesce(confirmed_at, now()), confirmed_by = coalesce(confirmed_by, auth.uid()), updated_at = now()
  where id = p_document_id;
end;
$$;

revoke all on function public.supplier_documents_feature_enabled(uuid, boolean),
  public.assert_supplier_document_venue(uuid, boolean), public.assert_supplier_document_scanning(uuid),
  public.can_access_supplier_document_object_without_addon(text), public.can_access_supplier_document_object(text),
  public.guard_supplier_document_addon_write(),
  public.create_supplier_document_archive(uuid, text, text, text, text),
  public.save_supplier_document_archive(uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.supplier_documents_feature_enabled(uuid, boolean),
  public.can_access_supplier_document_object(text), public.create_supplier_document_archive(uuid, text, text, text, text),
  public.save_supplier_document_archive(uuid, uuid, date, text) to authenticated;
grant execute on function public.assert_supplier_document_scanning(uuid) to authenticated, service_role;

-- Guard public RPC entry points; internal implementations keep their existing validations.

alter function public.create_supplier_document(uuid, text, text, text, text, text) rename to create_supplier_document_without_addon;
revoke all on function public.create_supplier_document_without_addon(uuid, text, text, text, text, text) from public, anon, authenticated, service_role;
create function public.create_supplier_document(
  p_venue_id uuid,
  p_document_type text,
  p_original_file_name text default null,
  p_original_mime_type text default null,
  p_file_hash text default null,
  p_mock_fixture_id text default null
)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform public.assert_supplier_document_venue(p_venue_id, true);
  return public.create_supplier_document_without_addon(p_venue_id, p_document_type, p_original_file_name, p_original_mime_type, p_file_hash, p_mock_fixture_id);
end;
$$;
revoke all on function public.create_supplier_document(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_supplier_document(uuid, text, text, text, text, text) to authenticated;

alter function public.save_supplier_document_line(uuid, uuid, uuid, uuid, numeric, text, numeric, numeric, text, numeric, numeric, numeric, numeric, boolean, boolean) rename to save_supplier_document_line_without_addon;
revoke all on function public.save_supplier_document_line_without_addon(uuid, uuid, uuid, uuid, numeric, text, numeric, numeric, text, numeric, numeric, numeric, numeric, boolean, boolean) from public, anon, authenticated, service_role;
create function public.save_supplier_document_line(
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
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.assert_supplier_document_scanning(p_document_id);
  perform public.save_supplier_document_line_without_addon(p_document_id, p_line_id, p_inventory_item_id, p_warehouse_id, p_quantity, p_purchase_unit, p_package_count, p_package_unit_quantity, p_package_unit_symbol, p_unit_price, p_discount_amount, p_base_quantity, p_normalized_unit_cost, p_update_reference_cost, p_reference_cost_decided);
end;
$$;
revoke all on function public.save_supplier_document_line(uuid, uuid, uuid, uuid, numeric, text, numeric, numeric, text, numeric, numeric, numeric, numeric, boolean, boolean) from public, anon, authenticated;
grant execute on function public.save_supplier_document_line(uuid, uuid, uuid, uuid, numeric, text, numeric, numeric, text, numeric, numeric, numeric, numeric, boolean, boolean) to authenticated;

alter function public.create_inventory_item_from_supplier_document(uuid, text, uuid, uuid, numeric) rename to create_inventory_item_from_supplier_document_without_addon;
revoke all on function public.create_inventory_item_from_supplier_document_without_addon(uuid, text, uuid, uuid, numeric) from public, anon, authenticated, service_role;
create function public.create_inventory_item_from_supplier_document(
  p_document_id uuid,
  p_name text,
  p_base_unit_id uuid,
  p_warehouse_id uuid,
  p_reference_cost numeric default null
)
returns uuid language plpgsql security definer set search_path to '' as $$
begin
  perform public.assert_supplier_document_scanning(p_document_id);
  return public.create_inventory_item_from_supplier_document_without_addon(p_document_id, p_name, p_base_unit_id, p_warehouse_id, p_reference_cost);
end;
$$;
revoke all on function public.create_inventory_item_from_supplier_document(uuid, text, uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.create_inventory_item_from_supplier_document(uuid, text, uuid, uuid, numeric) to authenticated;

alter function public.confirm_supplier_document(uuid, date, boolean, uuid[], text) rename to confirm_supplier_document_without_addon;
revoke all on function public.confirm_supplier_document_without_addon(uuid, date, boolean, uuid[], text) from public, anon, authenticated, service_role;
create function public.confirm_supplier_document(
  p_document_id uuid, p_document_date date, p_affects_stock boolean,
  p_delivery_note_ids uuid[] default '{}', p_document_number text default null
)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform public.assert_supplier_document_scanning(p_document_id);
  return public.confirm_supplier_document_without_addon(p_document_id, p_document_date, p_affects_stock, p_delivery_note_ids, p_document_number);
end;
$$;
revoke all on function public.confirm_supplier_document(uuid, date, boolean, uuid[], text) from public, anon, authenticated;
grant execute on function public.confirm_supplier_document(uuid, date, boolean, uuid[], text) to authenticated;

alter function public.correct_supplier_document_line(uuid, uuid, uuid, uuid, numeric, numeric, boolean) rename to correct_supplier_document_line_without_addon;
revoke all on function public.correct_supplier_document_line_without_addon(uuid, uuid, uuid, uuid, numeric, numeric, boolean) from public, anon, authenticated, service_role;
create function public.correct_supplier_document_line(
  p_document_id uuid,
  p_line_id uuid,
  p_inventory_item_id uuid,
  p_warehouse_id uuid,
  p_base_quantity numeric,
  p_normalized_unit_cost numeric,
  p_apply_stock boolean default false
)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform public.assert_supplier_document_scanning(p_document_id);
  return public.correct_supplier_document_line_without_addon(p_document_id, p_line_id, p_inventory_item_id, p_warehouse_id, p_base_quantity, p_normalized_unit_cost, p_apply_stock);
end;
$$;
revoke all on function public.correct_supplier_document_line(uuid, uuid, uuid, uuid, numeric, numeric, boolean) from public, anon, authenticated;
grant execute on function public.correct_supplier_document_line(uuid, uuid, uuid, uuid, numeric, numeric, boolean) to authenticated;

alter function public.update_supplier_document_supplier(uuid, uuid) rename to update_supplier_document_supplier_without_addon;
revoke all on function public.update_supplier_document_supplier_without_addon(uuid, uuid) from public, anon, authenticated, service_role;
create function public.update_supplier_document_supplier(p_document_id uuid, p_supplier_id uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform public.assert_supplier_document_scanning(p_document_id);
  return public.update_supplier_document_supplier_without_addon(p_document_id, p_supplier_id);
end;
$$;
revoke all on function public.update_supplier_document_supplier(uuid, uuid) from public, anon, authenticated;
grant execute on function public.update_supplier_document_supplier(uuid, uuid) to authenticated;

alter function public.replace_supplier_document_lines_from_ocr(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb) rename to replace_supplier_document_lines_from_ocr_without_addon;
revoke all on function public.replace_supplier_document_lines_from_ocr_without_addon(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb) from public, anon, authenticated, service_role;
create function public.replace_supplier_document_lines_from_ocr(
  p_document_id uuid, p_supplier_id uuid, p_expected_lines jsonb, p_allow_overwrite boolean,
  p_lines jsonb, p_profile_id uuid, p_profile_rules jsonb
)
returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.assert_supplier_document_scanning(p_document_id);
  perform public.replace_supplier_document_lines_from_ocr_without_addon(p_document_id, p_supplier_id, p_expected_lines, p_allow_overwrite, p_lines, p_profile_id, p_profile_rules);
end;
$$;
revoke all on function public.replace_supplier_document_lines_from_ocr(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_supplier_document_lines_from_ocr(uuid, uuid, jsonb, boolean, jsonb, uuid, jsonb) to service_role;

alter function public.save_venue_supplier(uuid, text, text, uuid) rename to save_venue_supplier_without_addon;
revoke all on function public.save_venue_supplier_without_addon(uuid, text, text, uuid) from public, anon, authenticated, service_role;
create function public.save_venue_supplier(
  p_venue_id uuid,
  p_name text,
  p_tax_id text default null,
  p_supplier_id uuid default null
)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform public.assert_supplier_document_venue(p_venue_id, false);
  return public.save_venue_supplier_without_addon(p_venue_id, p_name, p_tax_id, p_supplier_id);
end;
$$;
revoke all on function public.save_venue_supplier(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.save_venue_supplier(uuid, text, text, uuid) to authenticated;
