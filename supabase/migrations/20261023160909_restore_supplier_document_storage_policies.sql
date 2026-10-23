-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- Restored environments can retain documents/objects without their policies.
-- New names also allow this additive repair on healthy installations: the
-- predicates match the historical policies and grant no additional access there.
-- Use the current helper, including addon and tombstone checks. Originals remain
-- immutable: no UPDATE policy, bucket visibility change or object/data rewrite.
create policy supplier_document_originals_read
  on storage.objects for select to authenticated
  using (bucket_id = 'supplier-documents' and public.can_access_supplier_document_object(name));

create policy supplier_document_originals_insert
  on storage.objects for insert to authenticated
  with check (bucket_id = 'supplier-documents' and public.can_access_supplier_document_object(name));

create policy supplier_document_originals_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'supplier-documents' and public.can_access_supplier_document_object(name));
