-- Complete, portable catalog import/export for CRM owners and admins.
-- Both RPCs are SECURITY DEFINER and validate tenant administration internally.

CREATE OR REPLACE FUNCTION public.export_catalog(p_venue_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare v_venue public.venues%rowtype; v_tenant public.tenants%rowtype; v_catalog jsonb;
begin
  select * into v_venue from public.venues where id=p_venue_id;
  if not found then raise exception 'VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_venue.tenant_id) then raise exception 'CATALOG_EXPORT_FORBIDDEN'; end if;
  select * into v_tenant from public.tenants where id=v_venue.tenant_id;
  v_catalog := jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('category',c.id),'name',c.name,'icon',c.icon,'sortOrder',c.sort_order,'isActive',c.is_active,'unused',c.unused,'trace','{}'::jsonb,'source','{}'::jsonb) order by c.sort_order,c.name,c.id) from public.categories c where c.venue_id=p_venue_id),'[]'::jsonb),
    'saleFormats', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('sale_format',f.id),'name',f.name,'sortOrder',f.sort_order,'isActive',f.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by f.sort_order,f.name,f.id) from public.catalog_sale_formats f where f.venue_id=p_venue_id),'[]'::jsonb),
    'tabs', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('tab',t.id),'key',t.key,'label',t.label,'icon',t.icon,'sortOrder',t.sort_order,'isActive',t.is_active,'trace','{}'::jsonb) order by t.sort_order,t.label,t.id) from public.catalog_tabs t where t.venue_id=p_venue_id),'[]'::jsonb),
    'tabCategories', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('tab_category',x.id),'tabRef',public.catalog_export_ref('tab',x.tab_id),'categoryRef',public.catalog_export_ref('category',x.category_id),'sortOrder',x.sort_order,'isActive',x.is_active,'source','{}'::jsonb) order by x.sort_order,x.id) from public.catalog_tab_categories x where x.venue_id=p_venue_id),'[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('product',p.id),'type',p.product_type,'name',p.name,'description',p.description,'imageRef',case when pi.id is null then null else public.catalog_export_ref('image',pi.id) end,'taxRate',p.tax_rate,'sortOrder',p.sort_order,'isActive',p.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by p.sort_order,p.name,p.id) from public.products p left join public.product_images pi on pi.product_id=p.id where p.venue_id=p_venue_id),'[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('variant',v.id),'productRef',public.catalog_export_ref('product',v.product_id),'name',v.name,'saleFormatRef',case when v.catalog_sale_format_id is null then null else public.catalog_export_ref('sale_format',v.catalog_sale_format_id) end,'priceCents',v.price_cents,'sku',v.sku,'isDefault',v.is_default,'sortOrder',v.sort_order,'isActive',v.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by v.product_id,v.sort_order,v.name,v.id) from public.product_variants v where v.venue_id=p_venue_id),'[]'::jsonb),
    'placements', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('placement',x.id),'productRef',public.catalog_export_ref('product',x.product_id),'tabRef',public.catalog_export_ref('tab',x.tab_id),'categoryRef',case when x.category_id is null then null else public.catalog_export_ref('category',x.category_id) end,'variantRef',case when x.variant_id is null then null else public.catalog_export_ref('variant',x.variant_id) end,'featured',x.is_featured,'sortOrder',x.sort_order,'isActive',x.is_active,'trace','{}'::jsonb) order by x.tab_id,x.category_id nulls first,x.sort_order,x.id) from public.catalog_placements x where x.venue_id=p_venue_id),'[]'::jsonb),
    'selectionGroups', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_group',g.id),'name',g.name,'type',g.kind,'sortOrder',g.sort_order,'isActive',g.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by g.sort_order,g.name,g.id) from public.selection_groups g where g.venue_id=p_venue_id),'[]'::jsonb),
    'selectionGroupOptions', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_option',o.id),'groupRef',public.catalog_export_ref('selection_group',o.group_id),'productRef',public.catalog_export_ref('product',o.product_id),'variantRef',case when o.variant_id is null then null else public.catalog_export_ref('variant',o.variant_id) end,'supplementCents',o.supplement_cents,'defaultQuantity',o.default_quantity,'maxQuantity',o.max_quantity,'sortOrder',o.sort_order,'isActive',o.is_active,'trace','{}'::jsonb) order by o.group_id,o.sort_order,o.id) from public.selection_group_options o where o.venue_id=p_venue_id),'[]'::jsonb),
    'selectionAssignments', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_assignment',a.id),'productRef',public.catalog_export_ref('product',a.product_id),'groupRef',public.catalog_export_ref('selection_group',a.group_id),'variantRefs',coalesce((select jsonb_agg(public.catalog_export_ref('variant',av.variant_id) order by av.variant_id) from public.product_selection_group_assignment_variants av where av.assignment_id=a.id),'[]'::jsonb),'minSelection',a.min_selection,'maxSelection',a.max_selection,'sortOrder',a.sort_order,'isActive',a.is_active,'displayName',a.display_name,'trace','{}'::jsonb) order by a.product_id,a.sort_order,a.id) from public.product_selection_group_assignments a where a.venue_id=p_venue_id),'[]'::jsonb),
    'modifierGroups', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier_group',g.id),'name',g.name,'sortOrder',g.sort_order,'isActive',g.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by g.sort_order,g.name,g.id) from public.modifier_groups g where g.venue_id=p_venue_id),'[]'::jsonb),
    'modifiers', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier',m.id),'groupRef',public.catalog_export_ref('modifier_group',m.group_id),'name',m.name,'supplementCents',m.supplement_cents,'isDefault',m.is_default,'sortOrder',m.sort_order,'isActive',m.is_active,'trace','{}'::jsonb) order by m.group_id,m.sort_order,m.id) from public.modifiers m where m.venue_id=p_venue_id),'[]'::jsonb),
    'modifierAssignments', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier_assignment',a.id),'productRef',public.catalog_export_ref('product',a.product_id),'groupRef',public.catalog_export_ref('modifier_group',a.group_id),'variantRefs',coalesce((select jsonb_agg(public.catalog_export_ref('variant',av.variant_id) order by av.variant_id) from public.product_modifier_group_assignment_variants av where av.assignment_id=a.id),'[]'::jsonb),'minSelection',a.min_selection,'maxSelection',a.max_selection,'sortOrder',a.sort_order,'isActive',a.is_active,'displayName',a.display_name,'trace','{}'::jsonb) order by a.product_id,a.sort_order,a.id) from public.product_modifier_group_assignments a where a.venue_id=p_venue_id),'[]'::jsonb),
    'images', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('image',i.id),'productRef',public.catalog_export_ref('product',i.product_id),'file','images/'||public.catalog_export_ref('image',i.id)||case i.mime_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/gif' then '.gif' when 'image/avif' then '.avif' else '.webp' end,'mimeType',i.mime_type,'sizeBytes',i.size_bytes,'sha256',i.sha256,'missing',false,'trace','{}'::jsonb,'source',jsonb_build_object('storagePath',i.storage_path)) order by i.product_id,i.id) from public.product_images i where i.venue_id=p_venue_id),'[]'::jsonb)
  );
  return jsonb_build_object('format','club-pos-catalog-export','schemaVersion',4,'metadata',jsonb_build_object('exportedAt',to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'origin',jsonb_build_object('tenant',jsonb_build_object('name',v_tenant.name),'venue',jsonb_build_object('name',v_venue.name)),'fiscal',jsonb_build_object('defaultTaxRate',v_venue.default_tax_rate,'currencyCode',v_venue.currency_code,'timezone',v_venue.timezone),'counts',(select jsonb_object_agg(key,jsonb_array_length(value)) from jsonb_each(v_catalog))),'catalog',v_catalog);
end; $$;

CREATE OR REPLACE FUNCTION public.import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
    delete from public.catalog_sale_formats where venue_id=p_venue_id;
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
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,saleFormats}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_sale_formats(id,tenant_id,venue_id,name,is_active,sort_order) values ((p_plan->'generatedIds'->'saleFormats'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,products}') loop
    v_ref:=v_item->>'ref'; insert into public.products(id,tenant_id,venue_id,name,description,product_type,tax_rate,is_active,sort_order) values ((p_plan->'generatedIds'->'products'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',v_item->>'description',v_item->>'type',nullif(v_item->>'taxRate','')::numeric,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,variants}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid;
    insert into public.product_variants(id,tenant_id,venue_id,product_id,catalog_sale_format_id,name,price_cents,sku,is_default,is_active,sort_order) values ((p_plan->'generatedIds'->'variants'->>v_ref)::uuid,v_tenant,p_venue_id,v_product,(p_plan->'generatedIds'->'saleFormats'->>(v_item->>'saleFormatRef'))::uuid,v_item->>'name',(v_item->>'priceCents')::integer,v_item->>'sku',(v_item->>'isDefault')::boolean,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
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
    v_ref:=v_item->>'ref'; insert into public.selection_groups(id,tenant_id,venue_id,kind,name,sort_order,is_active) values ((p_plan->'generatedIds'->'selectionGroups'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'type',v_item->>'name',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
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
    v_ref:=v_item->>'ref'; insert into public.modifier_groups(id,tenant_id,venue_id,name,sort_order,is_active) values ((p_plan->'generatedIds'->'modifierGroups'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifiers}') loop
    v_ref:=v_item->>'ref'; insert into public.modifiers(id,tenant_id,venue_id,group_id,name,supplement_cents,is_default,is_active,sort_order) values ((p_plan->'generatedIds'->'modifiers'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'modifierGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'name',(v_item->>'supplementCents')::integer,(v_item->>'isDefault')::boolean,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifierAssignments}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid; v_assignment:=(p_plan->'generatedIds'->'modifierAssignments'->>v_ref)::uuid;
    insert into public.product_modifier_group_assignments(id,tenant_id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active) values (v_assignment,v_tenant,p_venue_id,v_product,(p_plan->'generatedIds'->'modifierGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'displayName',(v_item->>'minSelection')::integer,(v_item->>'maxSelection')::integer,jsonb_array_length(v_item->'variantRefs')=0,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
    for v_variant_ref in select jsonb_array_elements_text(v_item->'variantRefs') loop insert into public.product_modifier_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id) values(v_tenant,p_venue_id,v_assignment,v_product,(p_plan->'generatedIds'->'variants'->>v_variant_ref)::uuid); end loop;
  end loop;
  set constraints all immediate;
  return jsonb_build_object('result','SUCCESS','removedImagePaths',to_jsonb(v_removed_paths));
end; $$;

COMMENT ON FUNCTION public.import_catalog(uuid, text, jsonb)
  IS 'Transactional catalog replacement restricted to active tenant owners/admins and service_role.';

REVOKE ALL ON FUNCTION public.export_catalog(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_catalog(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.export_catalog(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.import_catalog(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_catalog(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.import_catalog(uuid, text, jsonb) TO service_role;