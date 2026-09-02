-- Keep supplier directories private to each venue while preserving the
-- optional link to global parser identities.

alter table public.suppliers
  add column if not exists venue_id uuid;

-- Existing supplier rows were tenant-wide. Preserve every venue in which a
-- supplier has already been used and clone only when the same legacy row was
-- shared by several venues. Suppliers without usage evidence are copied to
-- every existing venue so the migration does not make legacy data disappear.
create temporary table supplier_venue_migration on commit drop as
with evidenced_venues as (
  select distinct document.supplier_id as old_supplier_id,
    document.tenant_id,
    document.venue_id
  from public.supplier_documents document
  where document.supplier_id is not null
  union
  select distinct alias.supplier_id,
    alias.tenant_id,
    alias.venue_id
  from public.supplier_item_aliases alias
), supplier_venues as (
  select evidence.old_supplier_id, evidence.tenant_id, evidence.venue_id
  from evidenced_venues evidence
  union
  select supplier.id, supplier.tenant_id, venue.id
  from public.suppliers supplier
  join public.venues venue on venue.tenant_id = supplier.tenant_id
  where not exists (
    select 1
    from evidenced_venues evidence
    where evidence.old_supplier_id = supplier.id
  )
), ranked as (
  select supplier.id as old_supplier_id,
    supplier.tenant_id,
    supplier.global_supplier_id,
    supplier.name,
    supplier.tax_id,
    supplier.created_at,
    supplier.updated_at,
    supplier_venues.venue_id,
    row_number() over (
      partition by supplier.id
      order by supplier_venues.venue_id
    ) as venue_rank
  from public.suppliers supplier
  join supplier_venues on supplier_venues.old_supplier_id = supplier.id
)
select ranked.*,
  case
    when ranked.venue_rank = 1 then ranked.old_supplier_id
    else gen_random_uuid()
  end as new_supplier_id
from ranked;

do $$
begin
  if exists (
    select 1
    from public.suppliers supplier
    where not exists (
      select 1
      from supplier_venue_migration mapping
      where mapping.old_supplier_id = supplier.id
    )
  ) then
    raise exception 'SUPPLIER_VENUE_BACKFILL_REQUIRES_A_VENUE';
  end if;
end
$$;

update public.suppliers supplier
set venue_id = mapping.venue_id
from supplier_venue_migration mapping
where mapping.old_supplier_id = supplier.id
  and mapping.venue_rank = 1;

-- The previous tax-id uniqueness was tenant-wide and would reject the venue
-- clones below. It is replaced by venue-scoped uniqueness after the backfill.
drop index if exists public.suppliers_tenant_tax_id_unique;
drop index if exists public.suppliers_tenant_name_idx;

insert into public.suppliers (
  id,
  tenant_id,
  venue_id,
  global_supplier_id,
  name,
  tax_id,
  created_at,
  updated_at
)
select mapping.new_supplier_id,
  mapping.tenant_id,
  mapping.venue_id,
  mapping.global_supplier_id,
  mapping.name,
  mapping.tax_id,
  mapping.created_at,
  mapping.updated_at
from supplier_venue_migration mapping
where mapping.venue_rank > 1;

update public.supplier_documents document
set supplier_id = mapping.new_supplier_id
from supplier_venue_migration mapping
where mapping.old_supplier_id = document.supplier_id
  and mapping.tenant_id = document.tenant_id
  and mapping.venue_id = document.venue_id;

update public.supplier_item_aliases alias
set supplier_id = mapping.new_supplier_id
from supplier_venue_migration mapping
where mapping.old_supplier_id = alias.supplier_id
  and mapping.tenant_id = alias.tenant_id
  and mapping.venue_id = alias.venue_id;

alter table public.supplier_identity_aliases
  add column if not exists venue_id uuid;

alter table public.supplier_identity_aliases
  drop constraint supplier_identity_aliases_identity_unique,
  drop constraint supplier_identity_aliases_supplier_scope_fk;

create temporary table supplier_identity_venue_migration on commit drop as
select alias.id as old_alias_id,
  alias.tenant_id,
  mapping.venue_id,
  mapping.new_supplier_id,
  mapping.venue_rank,
  alias.identity_type,
  alias.normalized_value,
  alias.source,
  alias.confirmed_by,
  alias.created_at,
  alias.updated_at
from public.supplier_identity_aliases alias
join supplier_venue_migration mapping
  on mapping.old_supplier_id = alias.supplier_id
  and mapping.tenant_id = alias.tenant_id;

update public.supplier_identity_aliases alias
set supplier_id = mapping.new_supplier_id,
    venue_id = mapping.venue_id
from supplier_identity_venue_migration mapping
where mapping.old_alias_id = alias.id
  and mapping.venue_rank = 1;

insert into public.supplier_identity_aliases (
  id,
  tenant_id,
  venue_id,
  supplier_id,
  identity_type,
  normalized_value,
  source,
  confirmed_by,
  created_at,
  updated_at
)
select gen_random_uuid(),
  mapping.tenant_id,
  mapping.venue_id,
  mapping.new_supplier_id,
  mapping.identity_type,
  mapping.normalized_value,
  mapping.source,
  mapping.confirmed_by,
  mapping.created_at,
  mapping.updated_at
from supplier_identity_venue_migration mapping
where mapping.venue_rank > 1;

alter table public.suppliers
  alter column venue_id set not null;

alter table public.supplier_identity_aliases
  alter column venue_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'venues_scope_unique'
      and conrelid = 'public.venues'::regclass
  ) then
    alter table public.venues
      add constraint venues_scope_unique unique (id, tenant_id);
  end if;
end
$$;

alter table public.suppliers
  add constraint suppliers_venue_scope_unique unique (id, tenant_id, venue_id),
  add constraint suppliers_venue_scope_fk
    foreign key (venue_id, tenant_id)
    references public.venues(id, tenant_id) on delete cascade;

alter table public.supplier_documents
  drop constraint supplier_documents_supplier_scope_fk,
  add constraint supplier_documents_supplier_scope_fk
    foreign key (supplier_id, tenant_id, venue_id)
    references public.suppliers(id, tenant_id, venue_id);

alter table public.supplier_item_aliases
  drop constraint supplier_item_aliases_supplier_scope_fk,
  add constraint supplier_item_aliases_supplier_scope_fk
    foreign key (supplier_id, tenant_id, venue_id)
    references public.suppliers(id, tenant_id, venue_id) on delete cascade;

alter table public.supplier_identity_aliases
  add constraint supplier_identity_aliases_supplier_scope_fk
    foreign key (supplier_id, tenant_id, venue_id)
    references public.suppliers(id, tenant_id, venue_id) on delete cascade,
  add constraint supplier_identity_aliases_identity_unique
    unique (tenant_id, venue_id, identity_type, normalized_value);

create unique index suppliers_venue_tax_id_unique
  on public.suppliers (tenant_id, venue_id, upper(btrim(tax_id)))
  where nullif(btrim(tax_id), '') is not null;

create index suppliers_venue_name_idx
  on public.suppliers (tenant_id, venue_id, lower(name));

drop index if exists public.supplier_identity_aliases_supplier_idx;
create index supplier_identity_aliases_supplier_idx
  on public.supplier_identity_aliases
    (tenant_id, venue_id, supplier_id, updated_at desc);

drop policy suppliers_read on public.suppliers;
create policy suppliers_read
on public.suppliers
for select to authenticated
using ((select public.user_is_tenant_admin(tenant_id)));

drop policy supplier_identity_aliases_read on public.supplier_identity_aliases;
create policy supplier_identity_aliases_read
on public.supplier_identity_aliases
for select to authenticated
using ((select public.user_is_tenant_admin(tenant_id)));

revoke all on public.suppliers from public, anon, authenticated;
grant select on public.suppliers to authenticated;

create function public.save_venue_supplier(
  p_venue_id uuid,
  p_name text,
  p_tax_id text default null,
  p_supplier_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant_id uuid;
  v_name text;
  v_tax_id text;
  v_normalized_tax_id text;
  v_global_supplier_id uuid;
  v_supplier public.suppliers%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'SUPPLIER_UNAUTHENTICATED' using errcode = '42501';
  end if;

  select venue.tenant_id into v_tenant_id
  from public.venues venue
  where venue.id = p_venue_id;

  if v_tenant_id is null then
    raise exception 'SUPPLIER_VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not (select public.user_is_tenant_admin(v_tenant_id)) then
    raise exception 'SUPPLIER_FORBIDDEN' using errcode = '42501';
  end if;

  v_name := nullif(btrim(p_name), '');
  v_tax_id := nullif(upper(btrim(coalesce(p_tax_id, ''))), '');
  if v_name is null or char_length(v_name) > 160 then
    raise exception 'SUPPLIER_NAME_INVALID' using errcode = '22023';
  end if;
  if char_length(coalesce(v_tax_id, '')) > 40 then
    raise exception 'SUPPLIER_TAX_ID_INVALID' using errcode = '22023';
  end if;

  if p_supplier_id is not null then
    select supplier.* into v_supplier
    from public.suppliers supplier
    where supplier.id = p_supplier_id
      and supplier.tenant_id = v_tenant_id
      and supplier.venue_id = p_venue_id
    for update;
    if v_supplier.id is null then
      raise exception 'SUPPLIER_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  v_normalized_tax_id := nullif(
    upper(regexp_replace(coalesce(v_tax_id, ''), '[^A-Za-z0-9]', '', 'g')),
    ''
  );
  if char_length(coalesce(v_normalized_tax_id, '')) >= 6 then
    select global_supplier.id into v_global_supplier_id
    from public.global_suppliers global_supplier
    where upper(regexp_replace(coalesce(global_supplier.tax_id, ''), '[^A-Za-z0-9]', '', 'g'))
      = v_normalized_tax_id
    order by global_supplier.created_at, global_supplier.id
    limit 1;
  elsif p_supplier_id is not null and v_supplier.tax_id is null then
    v_global_supplier_id := v_supplier.global_supplier_id;
  end if;

  if p_supplier_id is null then
    insert into public.suppliers (
      tenant_id, venue_id, global_supplier_id, name, tax_id
    ) values (
      v_tenant_id, p_venue_id, v_global_supplier_id, v_name, v_tax_id
    )
    returning * into v_supplier;
  else
    update public.suppliers supplier
    set name = v_name,
        tax_id = v_tax_id,
        global_supplier_id = v_global_supplier_id,
        updated_at = now()
    where supplier.id = p_supplier_id
      and supplier.tenant_id = v_tenant_id
      and supplier.venue_id = p_venue_id
    returning supplier.* into v_supplier;
  end if;

  return jsonb_build_object(
    'id', v_supplier.id,
    'name', v_supplier.name,
    'taxId', v_supplier.tax_id
  );
end;
$$;

revoke all on function public.save_venue_supplier(uuid, text, text, uuid)
from public, anon, authenticated;
grant execute on function public.save_venue_supplier(uuid, text, text, uuid)
to authenticated;

create or replace function public.update_supplier_document_supplier(
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
  v_effective_global_supplier_id uuid;
  v_existing_alias public.supplier_identity_aliases%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'SUPPLIER_DOCUMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;

  select document.* into v_document
  from public.supplier_documents document
  where document.id = p_document_id
  for update;

  if v_document.id is null then
    raise exception 'SUPPLIER_DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not (select public.user_is_tenant_admin(v_document.tenant_id))
    and not (select public.user_has_venue_access(v_document.tenant_id, v_document.venue_id))
  then
    raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501';
  end if;
  if v_document.status <> 'review' then
    raise exception 'SUPPLIER_DOCUMENT_NOT_EDITABLE' using errcode = '55000';
  end if;

  select supplier.* into v_supplier
  from public.suppliers supplier
  where supplier.id = p_supplier_id
    and supplier.tenant_id = v_document.tenant_id
    and supplier.venue_id = v_document.venue_id
  for update;

  if v_supplier.id is null then
    raise exception 'SUPPLIER_DOCUMENT_SUPPLIER_INVALID' using errcode = '22023';
  end if;

  -- Link the local row to parser knowledge only with an exact normalized tax
  -- identity. Manual aliases still teach the venue-specific resolver below.
  if v_supplier.global_supplier_id is null
    and v_document.global_supplier_id is not null
    and exists (
      select 1
      from public.global_suppliers global_supplier
      where global_supplier.id = v_document.global_supplier_id
        and char_length(nullif(regexp_replace(coalesce(v_supplier.tax_id, ''), '[^A-Za-z0-9]', '', 'g'), '')) >= 6
        and upper(regexp_replace(coalesce(global_supplier.tax_id, ''), '[^A-Za-z0-9]', '', 'g'))
          = upper(regexp_replace(v_supplier.tax_id, '[^A-Za-z0-9]', '', 'g'))
    )
  then
    update public.suppliers supplier
    set global_supplier_id = v_document.global_supplier_id,
        updated_at = now()
    where supplier.id = v_supplier.id
      and supplier.tenant_id = v_supplier.tenant_id
      and supplier.venue_id = v_supplier.venue_id
    returning supplier.* into v_supplier;
  end if;

  v_effective_global_supplier_id := coalesce(
    v_supplier.global_supplier_id,
    v_document.global_supplier_id
  );

  update public.supplier_documents document
  set supplier_id = v_supplier.id,
      global_supplier_id = v_effective_global_supplier_id,
      global_profile_id = case
        when exists (
          select 1
          from public.global_supplier_document_profiles profile
          where profile.id = document.global_profile_id
            and profile.global_supplier_id = v_effective_global_supplier_id
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
      and alias.venue_id = v_document.venue_id
      and alias.identity_type = v_identity_type
      and alias.normalized_value = v_normalized_value
    for update;

    if found
      and v_existing_alias.source = 'user_confirmed'
      and v_existing_alias.supplier_id <> v_supplier.id
    then
      delete from public.supplier_identity_aliases alias
      where alias.id = v_existing_alias.id;
      continue;
    end if;

    insert into public.supplier_identity_aliases (
      tenant_id, venue_id, supplier_id, identity_type,
      normalized_value, source, confirmed_by
    ) values (
      v_document.tenant_id, v_document.venue_id, v_supplier.id, v_identity_type,
      v_normalized_value, 'user_confirmed', auth.uid()
    )
    on conflict (tenant_id, venue_id, identity_type, normalized_value)
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

comment on column public.suppliers.venue_id is
  'Owning venue. Supplier business data is never shared between venues.';
comment on column public.suppliers.global_supplier_id is
  'Optional parser-only link to a reusable global supplier identity.';
comment on function public.save_venue_supplier(uuid, text, text, uuid) is
  'Creates or edits a venue supplier and safely reuses an exact global tax identity when available.';
