create or replace function public.create_supplier_document(
  p_venue_id uuid,
  p_document_type text,
  p_affects_stock boolean,
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
  v_result jsonb;
  v_document_id uuid;
  v_affects_stock boolean;
begin
  v_result := public.create_supplier_document(
    p_venue_id,
    p_document_type,
    p_original_file_name,
    p_original_mime_type,
    p_file_hash,
    p_mock_fixture_id
  );
  v_document_id := (v_result ->> 'documentId')::uuid;

  if coalesce((v_result ->> 'duplicate')::boolean, false) then
    select document.affects_stock into v_affects_stock
    from public.supplier_documents document
    where document.id = v_document_id;
  else
    update public.supplier_documents
    set affects_stock = coalesce(p_affects_stock, true),
        updated_at = now()
    where id = v_document_id
    returning affects_stock into v_affects_stock;
  end if;

  return v_result || jsonb_build_object(
    'affectsStock', coalesce(v_affects_stock, true)
  );
end;
$$;

revoke all on function public.create_supplier_document(uuid, text, boolean, text, text, text, text)
from public, anon, authenticated;
grant execute on function public.create_supplier_document(uuid, text, boolean, text, text, text, text)
to authenticated;

comment on function public.create_supplier_document(uuid, text, boolean, text, text, text, text) is
  'Crea un documento de proveedor y persiste si debe actualizar stock al confirmarse.';
