-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve the read-only RPC signature, owner checks and grants for N-1 clients; adapt approved fields to the installed schema.
-- contracts-pending.yml reviewed: no destructive cleanup is performed here.
-- The legacy fiscal retirement contract remains pending: no tables or callers
-- are removed, and any remaining historical fiscal collections still export.
-- New tables/columns stay opt-in: discovering a schema change must never expose
-- secrets, infrastructure data or another tenant's rows automatically.

create or replace function public.export_tenant_data(p_tenant_id uuid, p_collection text default null, p_after jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  spec record; col record; pk record; rel regclass; selected text; ordering text; cursor_values text;
  cursor_types text; predicate text; scope text; result jsonb; manifest jsonb := '[]'; descriptors jsonb;
  key_count integer; actor_scope text; ref record; missing_fields jsonb; schema_token text;
  schema_changes jsonb := '[]'; required_fields text[];
begin
  if not public.can_export_tenant_data(p_tenant_id) then
    raise exception 'EXPORT_FORBIDDEN' using errcode='42501';
  end if;
  if p_collection is not null and not exists(select 1 from public.tenant_export_spec() where collection=p_collection) then
    raise exception 'EXPORT_UNKNOWN_COLLECTION' using errcode='22023';
  end if;
  for spec in select * from public.tenant_export_spec() where p_collection is null or collection=p_collection loop
    rel := to_regclass('public.' || spec.collection);
    if rel is null then
      if p_collection is not null then
        raise exception 'EXPORT_SCHEMA_CHANGED' using errcode='55000';
      end if;
      schema_changes := schema_changes || jsonb_build_array(jsonb_build_object('collection',spec.collection,'reason','table_unavailable'));
      continue;
    end if;
    -- Ordinary retired fields are omitted and documented. Scope and attachment
    -- ownership boundaries must remain usable; never fall back to unscoped data.
    required_fields := case when spec.collection='tenants' then array['id']
      when spec.collection='profiles' then array['id'] else array['tenant_id'] end;
    if spec.collection='catalog_audit_log' then required_fields := required_fields || array['table_name']; end if;
    if spec.collection='product_images' then required_fields := required_fields || array['id','storage_path','mime_type','sha256']; end if;
    if spec.collection='supplier_documents' then
      required_fields := required_fields || array['id','storage_bucket','storage_path','original_file_name','original_mime_type','deleted_at','storage_deleted_at'];
    end if;
    if exists(select 1 from unnest(required_fields) f(name) where not exists(
      select 1 from pg_catalog.pg_attribute a where a.attrelid=rel and a.attname=f.name and a.attnum>0 and not a.attisdropped)) then
      raise exception 'EXPORT_SCHEMA_UNAVAILABLE' using errcode='55000';
    end if;
    select coalesce(jsonb_agg(f.name order by f.n),'[]') into missing_fields
      from unnest(string_to_array(spec.fields,',')) with ordinality f(name,n)
      where not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=rel
        and a.attname=f.name and a.attnum>0 and not a.attisdropped);
    if missing_fields<>'[]'::jsonb then
      schema_changes := schema_changes || jsonb_build_array(jsonb_build_object('collection',spec.collection,'reason','columns_unavailable','columns',missing_fields));
    end if;
    selected := ''; descriptors := '[]';
    for col in select a.attname, a.atttypid, pg_catalog.format_type(a.atttypid,a.atttypmod) sql_type
      from pg_catalog.pg_attribute a
      where a.attrelid=rel and a.attnum>0 and not a.attisdropped
        and a.attname=any(string_to_array(spec.fields,',')) order by a.attnum
    loop
      selected := selected || case when selected='' then '' else ',' end || format('%L,%s',col.attname,
        case when spec.collection='catalog_audit_log' and col.attname in ('before_data','after_data') then
          format('(select jsonb_object_agg(e.key,e.value) from jsonb_each(t.%I) e where e.key=any(string_to_array((select s.fields from public.tenant_export_spec() s where s.collection=t.table_name),'','')))',col.attname)
        when spec.collection='supplier_documents' and col.attname='ocr_snapshot' then '(t.ocr_snapshot - ''metadata'' - ''provider'')'
        when col.atttypid in ('numeric'::regtype,'bigint'::regtype) then format('to_jsonb(t.%I::text)',col.attname)
          else format('to_jsonb(t.%I)',col.attname) end);
      descriptors := descriptors || jsonb_build_array(jsonb_build_object('name',col.attname,'type',col.sql_type,
        'encoding',case when col.atttypid in ('numeric'::regtype,'bigint'::regtype) then 'decimal-string' else 'json' end));
    end loop;
    if spec.collection='profiles' then
      selected := selected || ',''email'',(select to_jsonb(u.email) from auth.users u where u.id=t.id)';
      descriptors := descriptors || jsonb_build_array(jsonb_build_object('name','email','type','text','encoding','json'));
    end if;
    ordering := ''; cursor_values := ''; cursor_types := ''; key_count := 0;
    for pk in select a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod) sql_type
      from pg_catalog.pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,n)
      join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
      where i.indrelid=rel and i.indisprimary and k.n<=i.indnkeyatts order by k.n
    loop
      if pk.attname<>'tenant_id' and not pk.attname=any(string_to_array(spec.fields,',')) then
        raise exception 'EXPORT_SCHEMA_UNAVAILABLE' using errcode='55000';
      end if;
      ordering := ordering || case when ordering='' then '' else ',' end || format('t.%I',pk.attname);
      cursor_values := cursor_values || case when cursor_values='' then '' else ',' end || format('to_jsonb(t.%I::text)',pk.attname);
      cursor_types := cursor_types || case when cursor_types='' then '' else ',' end || format('($2->>%s)::%s',key_count,pk.sql_type);
      key_count := key_count+1;
    end loop;
    if key_count=0 then raise exception 'EXPORT_SCHEMA_UNAVAILABLE' using errcode='55000'; end if;
    if selected='' then raise exception 'EXPORT_SCHEMA_UNAVAILABLE' using errcode='55000'; end if;
    schema_token := md5(jsonb_build_object('columns',descriptors,'keys',ordering,'keyTypes',cursor_types)::text);
    if p_collection is null then
      manifest := manifest || jsonb_build_array(jsonb_build_object('name',spec.collection,'columns',descriptors,'schemaToken',schema_token));
      continue;
    end if;
    if p_after is not null and (jsonb_typeof(p_after)<>'array' or jsonb_array_length(p_after)<>key_count
      or exists(select 1 from jsonb_array_elements(p_after) v where v='null'::jsonb)) then
      raise exception 'EXPORT_INVALID_CURSOR' using errcode='22023';
    end if;
    scope := 't.tenant_id=$1';
    if spec.collection='tenants' then scope := 't.id=$1'; end if;
    if spec.collection='profiles' then
      -- Include former staff referenced in the tenant's history, without exporting
      -- their roles, emails or activity in any other business.
      actor_scope := 'exists(select 1 from public.tenant_memberships m where m.tenant_id=$1 and m.user_id=t.id)';
      for ref in select distinct c.relname,a.attname
        from pg_catalog.pg_constraint fk join pg_catalog.pg_class c on c.oid=fk.conrelid
        join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum=fk.conkey[1]
        join public.tenant_export_spec() s on s.collection=c.relname
        where fk.contype='f' and array_length(fk.conkey,1)=1 and fk.confrelid in (rel,'auth.users'::regclass)
          and a.attname=any(string_to_array(s.fields,','))
          and exists(select 1 from pg_catalog.pg_attribute ta where ta.attrelid=c.oid and ta.attname='tenant_id' and not ta.attisdropped)
      loop
        actor_scope := actor_scope || format(' or exists(select 1 from public.%I r where r.tenant_id=$1 and r.%I=t.id)',ref.relname,ref.attname);
      end loop;
      scope := '(' || actor_scope || ')';
    end if;
    predicate := case when p_after is null then '' else format(' and row(%s)>row(%s)',ordering,cursor_types) end;
    -- Transport each row as JSON text: a browser must not round decimal numbers
    -- nested inside immutable fiscal/catalog snapshots while preparing the ZIP.
    execute format('select jsonb_build_object(''rows'',coalesce(jsonb_agg(x.data::text order by x.n),''[]''),
      ''next'',(jsonb_agg(x.cursor order by x.n desc)->0),''readAt'',statement_timestamp()) from (
      select jsonb_build_object(%s) data,jsonb_build_array(%s) cursor,row_number() over(order by %s) n
      from public.%I t where %s %s order by %s limit 500) x',
      selected,cursor_values,ordering,spec.collection,scope,predicate,ordering) into result using p_tenant_id,p_after;
    -- Storage addresses are transport metadata, never fields in the final archive.
    if spec.collection in ('product_images','supplier_documents') then
      if spec.collection='product_images' then
        execute 'select coalesce(jsonb_agg(jsonb_build_object(''id'',id,''bucket'',''product-images'',''path'',storage_path,''mimeType'',mime_type,''sha256'',sha256)),''[]'')
          from public.product_images where tenant_id=$1 and id in(select (((v#>>''{}'')::jsonb)->>''id'')::uuid from jsonb_array_elements($2) v)'
          into descriptors using p_tenant_id,result->'rows';
      else
        -- file_hash fingerprints the received source before image-to-WebP
        -- conversion; it is not a checksum of the stored document bytes.
        execute 'select coalesce(jsonb_agg(jsonb_build_object(''id'',id,''bucket'',storage_bucket,''path'',storage_path,''mimeType'',original_mime_type,''sha256'',null)),''[]'')
          from public.supplier_documents where tenant_id=$1 and deleted_at is null and storage_deleted_at is null
            and (storage_bucket is not null or storage_path is not null or original_file_name is not null)
            and id in(select (((v#>>''{}'')::jsonb)->>''id'')::uuid from jsonb_array_elements($2) v)'
          into descriptors using p_tenant_id,result->'rows';
      end if;
      result := result || jsonb_build_object('files',descriptors);
    end if;
    return result || jsonb_build_object('schemaToken',schema_token);
  end loop;
  return jsonb_build_object('format','tickit-tenant-export','schemaVersion',1,'collections',manifest,'schemaChanges',schema_changes,'readAt',statement_timestamp());
end;
$$;
