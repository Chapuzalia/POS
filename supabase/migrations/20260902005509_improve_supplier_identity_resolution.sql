-- Persist only supplier identities that a user explicitly confirms while
-- reviewing a supplier document. The supplier itself remains tenant-scoped.

create table public.supplier_identity_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  supplier_id uuid not null,
  identity_type text not null,
  normalized_value text not null,
  source text not null default 'user_confirmed',
  confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_identity_aliases_supplier_scope_fk
    foreign key (supplier_id, tenant_id)
    references public.suppliers(id, tenant_id) on delete cascade,
  constraint supplier_identity_aliases_type_check
    check (identity_type in ('tax_id', 'email', 'email_domain', 'phone', 'address', 'name')),
  constraint supplier_identity_aliases_value_check
    check (btrim(normalized_value) <> '' and char_length(normalized_value) <= 500),
  constraint supplier_identity_aliases_source_check
    check (source in ('user_confirmed', 'extracted')),
  constraint supplier_identity_aliases_identity_unique
    unique (tenant_id, identity_type, normalized_value)
);

create index supplier_identity_aliases_supplier_idx
  on public.supplier_identity_aliases (tenant_id, supplier_id, updated_at desc);

create trigger set_supplier_identity_aliases_updated_at
before update on public.supplier_identity_aliases
for each row execute function public.set_updated_at();

alter table public.supplier_identity_aliases enable row level security;

create policy supplier_identity_aliases_read
on public.supplier_identity_aliases
for select to authenticated
using (public.user_is_tenant_admin(tenant_id));

revoke all on public.supplier_identity_aliases from public, anon, authenticated;
grant select on public.supplier_identity_aliases to authenticated;

create function public.update_supplier_document_supplier(
  p_document_id uuid,
  p_supplier_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_document public.supplier_documents%rowtype;
  v_supplier public.suppliers%rowtype;
  v_identity jsonb;
  v_identity_type text;
  v_normalized_value text;
  v_existing_alias public.supplier_identity_aliases%rowtype;
begin
  if auth.uid() is null then
    raise exception 'SUPPLIER_DOCUMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;

  select document.* into v_document
  from public.supplier_documents document
  where document.id = p_document_id
  for update;

  if v_document.id is null then
    raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.user_is_tenant_admin(v_document.tenant_id)
    and not public.user_has_venue_access(v_document.tenant_id, v_document.venue_id)
  then
    raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501';
  end if;
  if v_document.status <> 'review' then
    raise exception 'SUPPLIER_DOCUMENT_NOT_EDITABLE' using errcode = '55000';
  end if;

  select supplier.* into v_supplier
  from public.suppliers supplier
  where supplier.id = p_supplier_id
    and supplier.tenant_id = v_document.tenant_id;

  if v_supplier.id is null then
    raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_INVALID' using errcode = '22023';
  end if;

  update public.supplier_documents document
  set supplier_id = v_supplier.id,
      global_supplier_id = v_supplier.global_supplier_id,
      global_profile_id = case
        when exists (
          select 1
          from public.global_supplier_document_profiles profile
          where profile.id = document.global_profile_id
            and profile.global_supplier_id = v_supplier.global_supplier_id
        ) then document.global_profile_id
        else null
      end,
      extraction_metadata = coalesce(document.extraction_metadata, '{}'::jsonb)
        || jsonb_build_object(
          'supplierResolution', jsonb_build_object(
            'supplierId', v_supplier.id,
            'confidence', 'high',
            'signals', '[]'::jsonb,
            'reasons', jsonb_build_array('manual_selection')
          )
        ),
      updated_at = now()
  where document.id = v_document.id;

  for v_identity in
    select value
    from jsonb_array_elements(
      coalesce(v_document.extraction_metadata #> '{supplierExtraction,identities}', '[]'::jsonb)
    )
  loop
    v_identity_type := v_identity ->> 'type';
    v_normalized_value := nullif(btrim(v_identity ->> 'normalizedValue'), '');
    if v_identity_type not in ('tax_id', 'email', 'email_domain', 'phone', 'address', 'name')
      or v_normalized_value is null
      or char_length(v_normalized_value) > 500
    then
      continue;
    end if;

    select alias.* into v_existing_alias
    from public.supplier_identity_aliases alias
    where alias.tenant_id = v_document.tenant_id
      and alias.identity_type = v_identity_type
      and alias.normalized_value = v_normalized_value
    for update;

    if found
      and v_existing_alias.source = 'user_confirmed'
      and v_existing_alias.supplier_id <> v_supplier.id
    then
      -- Two explicit corrections disagree: the identity is ambiguous and must
      -- not remain available for future automatic resolution.
      delete from public.supplier_identity_aliases alias
      where alias.id = v_existing_alias.id;
      continue;
    end if;

    insert into public.supplier_identity_aliases (
      tenant_id, supplier_id, identity_type, normalized_value, source, confirmed_by
    ) values (
      v_document.tenant_id, v_supplier.id, v_identity_type,
      v_normalized_value, 'user_confirmed', auth.uid()
    )
    on conflict (tenant_id, identity_type, normalized_value)
    do update set
      supplier_id = excluded.supplier_id,
      source = 'user_confirmed',
      confirmed_by = excluded.confirmed_by,
      updated_at = now()
    where public.supplier_identity_aliases.source = 'extracted'
      or public.supplier_identity_aliases.supplier_id = excluded.supplier_id;
  end loop;

  return jsonb_build_object(
    'documentId', v_document.id,
    'supplierId', v_supplier.id,
    'supplierName', v_supplier.name
  );
end;
$$;

revoke all on function public.update_supplier_document_supplier(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.update_supplier_document_supplier(uuid, uuid)
to authenticated;
