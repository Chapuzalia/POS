-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New read-only export API, available only to authenticated owners of the requested tenant.
-- contracts-pending.yml reviewed: unrelated destructive legacy cleanup remains pending;
-- exporting historical legacy invoices does not authorize removing them or their N-1 callers.

-- Frozen field allowlist: adding a database column never adds it to an export.
create function public.tenant_export_spec()
returns table(collection text, fields text)
language sql immutable security invoker set search_path = '' as $$
  values
  ('tenants','id,name,slug,created_at'),
  ('venues','id,name,address,legal_name,tax_id,sort_order,is_active,created_at,updated_at,tables_enabled,default_tax_rate,manual_discount_enabled,manual_discount_requires_pin,timezone,day_change_time,currency_code,catalog_profile,inventory_enabled,production_enabled,fiscal_code,tickit_assist_enabled,tickit_assist_sensitivity'),
  ('profiles','id,full_name,created_at'),
  ('tenant_memberships','id,user_id,role,is_active,created_at,updated_at'),
  ('manager_venue_assignments','manager_user_id,venue_id,created_at'),
  ('device_user_assignments','id,user_id,venue_id,device_id,is_active,created_at,updated_at'),
  ('devices','id,venue_id,name,is_active,device_mode,default_cash_register_id,can_take_orders,can_take_payments,can_open_cash_session,can_close_cash_session,can_manage_cash,production_destination_id,created_at,updated_at'),
  ('cash_registers','id,venue_id,name,is_active,sort_order,fiscal_code,created_at,updated_at'),
  ('categories','id,venue_id,name,icon,sort_order,is_active,unused,created_at,updated_at'),
  ('catalog_sale_formats','id,venue_id,name,is_active,sort_order,inventory_consumption_quantity,inventory_consumption_unit_id,created_at,updated_at'),
  ('catalog_tabs','id,venue_id,key,label,icon,sort_order,is_active,created_at,updated_at'),
  ('catalog_tab_categories','id,venue_id,tab_id,category_id,sort_order,is_active,created_at,updated_at'),
  ('catalog_placements','id,venue_id,tab_id,category_id,product_id,variant_id,is_featured,sort_order,is_active,created_at,updated_at'),
  ('catalog_audit_log','id,venue_id,table_name,row_id,action,actor_id,before_data,after_data,created_at'),
  ('products','id,venue_id,name,description,is_active,sort_order,tax_rate,product_type,created_at,updated_at'),
  ('product_variants','id,venue_id,product_id,name,price_cents,sku,is_default,sort_order,is_active,catalog_sale_format_id,created_at,updated_at'),
  ('product_images','id,venue_id,product_id,mime_type,size_bytes,sha256,created_at,updated_at'),
  ('selection_groups','id,venue_id,kind,name,sort_order,is_active,created_at,updated_at'),
  ('selection_group_options','id,venue_id,group_id,product_id,variant_id,supplement_cents,default_quantity,max_quantity,sort_order,is_active,created_at,updated_at'),
  ('product_selection_group_assignments','id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active,created_at,updated_at'),
  ('product_selection_group_assignment_variants','venue_id,assignment_id,product_id,variant_id,created_at'),
  ('modifier_groups','id,venue_id,name,sort_order,is_active,created_at,updated_at'),
  ('modifiers','id,venue_id,group_id,name,sort_order,is_default,is_active,supplement_cents,created_at,updated_at'),
  ('product_modifier_group_assignments','id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active,created_at,updated_at'),
  ('product_modifier_group_assignment_variants','venue_id,assignment_id,product_id,variant_id,created_at'),
  ('discounts','id,venue_id,name,type,value,color,is_active,sort_order,rounding_increment_cents,rule_kind,scope,requires_pin,active_weekdays,starts_at,ends_at,auto_apply,fixed_application,created_at,updated_at'),
  ('discount_targets','id,venue_id,discount_id,product_id,variant_id,created_at'),
  ('customers','id,legal_name,tax_id,address,postal_code,city,province,country,email,phone,created_at,updated_at'),
  ('cash_sessions','id,venue_id,device_id,opened_by,closed_by,status,opening_float_cents,opened_at,closed_at,expected_cash_cents,expected_card_cents,expected_invitation_cents,expected_other_cents,counted_cash_cents,counted_card_cents,counted_invitation_cents,counted_other_cents,discrepancy_cents,notes,cash_register_id,opened_by_device_id,closed_by_device_id,final_cash_fund_cents,print_snapshot,created_at,updated_at'),
  ('cash_movements','id,venue_id,cash_session_id,created_by,direction,amount_cents,category,notes,created_at'),
  ('cash_session_stacker_collections','id,venue_id,cash_session_id,device_id,created_by,amount_cents,created_at'),
  ('cash_closing_count_edits','id,cash_closing_id,venue_id,actor_id,previous_counted_cash_cents,previous_counted_card_cents,counted_cash_cents,counted_card_cents,created_at'),
  ('imported_cash_closings','id,venue_id,source,business_date,cash_cents,card_cents,cash_tip_cents,card_tip_cents,source_row_count,file_name,imported_by,imported_at'),
  ('tickets','id,cash_session_id,venue_id,device_id,user_id,status,subtotal_cents,total_cents,local_created_at,created_at,updated_at,cash_register_id,ticket_number,discount_id,discount_name,discount_type,discount_value_type,discount_value,discount_amount_cents,equal_split_id,equal_split_part_number,discount_rounding_increment_cents,discount_rule_kind,discount_scope,discount_automatic,discount_snapshot,is_invoice,customer_id,customer_snapshot,invoice_series,invoice_number,invoice_issued_at'),
  ('ticket_lines','id,ticket_id,product_id,variant_id,product_name,variant_name,quantity,unit_price_cents,line_total_cents,modifiers,tax_rate,taxable_base_cents,tax_amount_cents,allocated_quantity,sale_format_id,sale_format_name_snapshot,category_id_snapshot,category_name_snapshot,catalog_tab_id_snapshot,catalog_tab_name_snapshot,base_price_cents,component_delta_cents,modifier_delta_cents,gross_before_discount_cents,discount_amount_cents,net_total_cents,source_order_line_id,theoretical_cost_cents,theoretical_cost_known,created_at'),
  ('ticket_line_components','id,ticket_line_id,component_type,selection_group_id,selection_group_name_snapshot,product_id,variant_id,product_name_snapshot,variant_name_snapshot,quantity,price_delta_cents,sort_order,metadata,created_at'),
  ('sales','id,ticket_id,cash_session_id,venue_id,device_id,user_id,total_cents,payment_method,local_created_at,cash_register_id,created_at,updated_at'),
  ('sale_payments','id,sale_id,method,amount_cents,received_cents,change_cents,equal_split_part_number,created_at'),
  ('refund_requests','id,venue_id,original_ticket_id,original_sale_id,original_cash_session_id,refund_cash_session_id,refund_method,total_cents,fiscal_series,fiscal_status,fiscal_rectificative_record,actor_id,created_at'),
  ('refund_lines','id,refund_request_id,original_ticket_line_id,quantity,unit_price_cents,gross_cents,discount_cents,net_total_cents,product_name,variant_name,modifiers,tax_rate,taxable_base_cents,tax_amount_cents,created_at'),
  ('refund_payments','id,refund_request_id,method,amount_cents,payment_snapshot,created_at'),
  ('dining_areas','id,venue_id,name,sort_order,is_active,canvas_width,canvas_height,map_elements,created_at,updated_at'),
  ('restaurant_tables','id,venue_id,area_id,name,capacity,shape,position_x,position_y,width,height,is_active,sort_order,reserved_until,reservation_note,cash_session_id,created_at,updated_at'),
  ('venue_table_layouts','venue_id,tables,updated_by,updated_at'),
  ('cash_session_table_layouts','cash_session_id,venue_id,cash_register_id,tables,updated_by,created_at,updated_at'),
  ('reservations','id,venue_id,customer_name,customer_phone,customer_email,party_size,starts_at,ends_at,status,notes,cancellation_reason,order_id,arrived_at,seated_at,completed_at,cancelled_at,created_at,updated_at'),
  ('reservation_tables','id,reservation_id,table_id,venue_id,table_name,assigned_at'),
  ('order_groups','id,venue_id,cash_session_id,status,opened_at,closed_at,updated_at'),
  ('order_events','id,venue_id,order_id,user_id,device_id,event_type,payload,created_at'),
  ('orders','id,venue_id,cash_session_id,opened_by_user_id,opened_by_device_id,guest_count,status,opened_at,updated_at,closed_at,cash_register_id,order_group_id,split_sequence,draft_discount'),
  ('order_tables','id,venue_id,order_id,table_id,table_name,joined_at,released_at,order_group_id'),
  ('order_lines','id,venue_id,order_id,product_id,variant_id,product_name,variant_name,unit_price_cents,quantity,modifiers,note,served_quantity,fully_served_at,mixer_product_id,mixer,split_from_line_id,components,catalog_snapshot,created_at,updated_at'),
  ('order_line_components','id,venue_id,order_line_id,component_type,selection_group_id,product_id,variant_id,product_name_snapshot,variant_name_snapshot,quantity,price_delta_cents,sort_order,metadata,created_at'),
  ('restaurant_order_equal_splits','id,venue_id,order_group_id,order_id,total_cents,part_count,paid_parts,paid_cents,allow_pending_service,status,completed_at,default_discount,single_ticket,settlement_cash_session_id,created_at,updated_at'),
  ('restaurant_order_equal_split_payments','id,venue_id,split_id,part_number,amount_cents,payment_method,received_cents,change_cents,ticket_id,sale_id,subtotal_cents,discount_amount_cents,discount,created_at'),
  ('restaurant_equal_split_tenders','id,venue_id,split_id,part_number,subtotal_cents,discount_amount_cents,discount,amount_cents,method,received_cents,change_cents,device_id,user_id,custom_payments,created_at'),
  ('restaurant_order_carryovers','id,venue_id,order_group_id,order_ids,from_cash_session_id,to_cash_session_id,carried_at,carried_by,carried_by_device_id,recovered_at,recovered_by,recovered_by_device_id,table_layout,parked_table_ids'),
  ('production_destinations','id,venue_id,name,is_active,sort_order,kds_enabled,printer_id,created_at,updated_at'),
  ('production_print_agents','id,venue_id,instance_id,is_active,created_at,updated_at'),
  ('production_agent_printers','agent_id,venue_id,printer_id,display_name,paper_width,character_set'),
  ('tickit_assist_situations','id,venue_id,kind,entity_id,severity,started_at,ended_at,metrics'),
  ('tickit_assist_feedback','situation_id,user_id,venue_id,feedback,created_at'),
  ('production_category_routes','venue_id,category_id,destination_id,created_at,updated_at'),
  ('production_product_routes','venue_id,product_id,destination_id,created_at,updated_at'),
  ('production_passes','id,venue_id,name,sort_order,is_active,created_at,updated_at'),
  ('production_category_pass_routes','venue_id,category_id,pass_id,created_at,updated_at'),
  ('production_product_pass_routes','venue_id,product_id,pass_id,created_at,updated_at'),
  ('production_batches','id,venue_id,order_id,sequence,actor_user_id,actor_device_id,pass_id,pass_name,created_at'),
  ('production_events','id,venue_id,batch_id,production_item_id,destination_id,event_type,quantity,payload,actor_user_id,actor_device_id,acknowledged_at,created_at'),
  ('production_items','id,venue_id,batch_id,destination_id,source_order_id,source_order_line_id,source_component_id,product_id,variant_id,quantity,units_per_commercial_unit,ready_quantity,cancelled_quantity,snapshot,pass_id,pass_name,accepted_at,created_at,updated_at'),
  ('production_line_allocations','id,venue_id,batch_id,source_order_line_id,current_order_line_id,quantity,ready_quantity,cancelled_quantity,created_at,updated_at'),
  ('production_component_allocations','id,venue_id,batch_id,source_order_line_id,current_order_line_id,source_component_id,quantity,ready_quantity,cancelled_quantity,created_at,updated_at'),
  ('order_line_production_passes','id,venue_id,order_line_id,component_id,pass_id,pass_name,skipped_quantity,served_quantity,created_at,updated_at'),
  ('inventory_units','id,venue_id,name,symbol,decimal_places,is_active,sort_order,content_quantity,content_unit_id,created_at,updated_at'),
  ('inventory_warehouses','id,venue_id,name,description,is_active,sort_order,created_at,updated_at'),
  ('inventory_items','id,venue_id,name,description,base_unit_id,is_active,reference_cost,last_purchase_cost,average_cost,created_at,updated_at'),
  ('inventory_product_settings','product_id,venue_id,unit_id,content_quantity,content_unit_id,created_at,updated_at'),
  ('inventory_product_format_consumptions','product_id,sale_format_id,venue_id,quantity,created_at,updated_at'),
  ('inventory_device_warehouses','device_id,warehouse_id,venue_id,is_enabled,priority,created_at,updated_at'),
  ('inventory_item_warehouse_routes','inventory_item_id,warehouse_id,venue_id,priority,is_enabled,created_at,updated_at'),
  ('inventory_stock_levels','warehouse_id,inventory_item_id,venue_id,quantity,is_enabled,target_quantity,created_at,updated_at'),
  ('inventory_stock_movements','id,venue_id,warehouse_id,product_id,ticket_line_id,sale_format_id,source_type,stock_quantity_delta,stock_quantity_before,stock_quantity_after,format_consumption_quantity,sold_quantity,content_unit_id,inventory_item_id,unit_id,source_id,production_id,metadata,created_at'),
  ('inventory_recipes','id,venue_id,variant_id,mode,is_active,created_at,updated_at'),
  ('inventory_recipe_lines','id,recipe_id,venue_id,inventory_item_id,quantity,unit_id,uses_format_default,sort_order,created_at,updated_at'),
  ('modifier_inventory_effects','id,venue_id,modifier_id,operation,inventory_item_id,quantity,unit_id,sort_order,created_at,updated_at'),
  ('inventory_production_recipes','id,venue_id,inventory_item_id,production_warehouse_id,reference_quantity,reference_unit_id,is_active,created_at,updated_at'),
  ('inventory_production_recipe_lines','id,recipe_id,venue_id,inventory_item_id,quantity,unit_id,sort_order,created_at,updated_at'),
  ('inventory_productions','id,venue_id,inventory_item_id,warehouse_id,quantity,unit_id,stock_quantity,recipe_id,recipe_snapshot,user_id,device_id,created_at'),
  ('inventory_reference_cost_history','id,venue_id,inventory_item_id,supplier_document_id,supplier_document_line_id,previous_cost,new_cost,changed_by,created_at'),
  ('suppliers','id,venue_id,name,tax_id,legal_name,email,phone,address,created_at,updated_at'),
  ('supplier_documents','id,venue_id,supplier_id,document_type,document_number,document_date,original_file_name,original_mime_type,file_hash,status,ocr_snapshot,created_by,confirmed_by,confirmed_at,affects_stock,stock_applied_at,processing_mode,deleted_at,storage_deleted_at,created_at,updated_at'),
  ('supplier_document_lines','id,supplier_document_id,venue_id,line_number,supplier_reference,description_raw,description_normalized,barcode,quantity,purchase_unit,package_count,package_unit_quantity,package_unit_symbol,unit_price,discount_amount,charges_amount,gross_cost,net_cost,line_total,tax_rate,inventory_item_id,warehouse_id,base_quantity,normalized_unit_cost,match_status,extraction_confidence,update_reference_cost,reference_cost_decided,was_corrected,created_at,updated_at'),
  ('supplier_item_aliases','id,venue_id,supplier_id,alias_type,alias_value,inventory_item_id,packaging_json,created_at,updated_at'),
  ('supplier_identity_aliases','id,venue_id,supplier_id,identity_type,normalized_value,created_at,updated_at'),
  ('supplier_document_links','id,venue_id,invoice_document_id,delivery_note_document_id,created_by,created_at'),
  ('print_templates','id,venue_id,type,name,definition,is_active,created_at,updated_at'),
  ('fiscal_subjects','id,legal_name,nif,created_at'),
  ('fiscal_sif_installations','id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,venue_code,register_code,installation_code,mode,retired_at,installation_sequence,series_version,created_at'),
  ('fiscal_local_series','id,fiscal_subject_id,installation_id,venue_id,cash_register_id,device_id,document_kind,exercise,series,last_number,created_at'),
  ('fiscal_local_records','id,fiscal_subject_id,installation_id,venue_id,cash_register_id,invoice_id,ticket_id,sale_id,record_kind,chain_position,previous_hash,hash,canonical_schema,canonical_record,record_envelope,invoice_snapshot,economic_snapshot,generated_at,refund_request_id,created_at'),
  ('fiscal_invoice_sequences','series,last_value,updated_at'),
  ('fiscal_invoice_events','id,venue_id,fiscal_invoice_id,source,event_type,status,error_code,created_at'),
  ('fiscal_invoices','id,venue_id,ticket_id,sale_id,provider,environment,invoice_type,series,number,issue_date,operation_date,document_data,status,pending_operation,external_uuid,external_code,qr_base64,verification_url,error_code,issued_at,sent_at,confirmed_at,cancelled_at,created_at,updated_at');
$$;

create function public.can_export_tenant_data(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.tenant_memberships m
    where m.tenant_id=p_tenant_id and m.user_id=(select auth.uid()) and m.role='owner' and m.is_active);
$$;

-- Scalar JSON envelopes avoid PostgREST's row cap. Native primary-key cursors
-- keep large histories paginated without OFFSET or locks on operational rows.
create function public.export_tenant_data(p_tenant_id uuid, p_collection text default null, p_after jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  spec record; col record; pk record; rel regclass; selected text; ordering text; cursor_values text;
  cursor_types text; predicate text; scope text; result jsonb; manifest jsonb := '[]'; descriptors jsonb;
  key_count integer; actor_scope text; ref record;
begin
  if not public.can_export_tenant_data(p_tenant_id) then
    raise exception 'EXPORT_FORBIDDEN' using errcode='42501';
  end if;
  if p_collection is not null and not exists(select 1 from public.tenant_export_spec() where collection=p_collection) then
    raise exception 'EXPORT_UNKNOWN_COLLECTION' using errcode='22023';
  end if;
  for spec in select * from public.tenant_export_spec() where p_collection is null or collection=p_collection loop
    rel := to_regclass('public.' || spec.collection);
    -- Legacy fiscal tables may have been retired after the N-1 window.
    if rel is null then
      if spec.collection in ('fiscal_invoices','fiscal_invoice_sequences','fiscal_invoice_events') then continue; end if;
      raise exception 'EXPORT_SCHEMA_UNAVAILABLE' using errcode='55000';
    end if;
    if exists(select 1 from unnest(string_to_array(spec.fields,',')) f(name)
      where not exists(select 1 from pg_catalog.pg_attribute a where a.attrelid=rel
        and a.attname=f.name and a.attnum>0 and not a.attisdropped)) then
      raise exception 'EXPORT_SCHEMA_UNAVAILABLE' using errcode='55000';
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
    if p_collection is null then
      manifest := manifest || jsonb_build_array(jsonb_build_object('name',spec.collection,'columns',descriptors));
      continue;
    end if;
    ordering := ''; cursor_values := ''; cursor_types := ''; key_count := 0;
    for pk in select a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod) sql_type
      from pg_catalog.pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum,n)
      join pg_catalog.pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
      where i.indrelid=rel and i.indisprimary order by k.n
    loop
      ordering := ordering || case when ordering='' then '' else ',' end || format('t.%I',pk.attname);
      cursor_values := cursor_values || case when cursor_values='' then '' else ',' end || format('to_jsonb(t.%I::text)',pk.attname);
      cursor_types := cursor_types || case when cursor_types='' then '' else ',' end || format('($2->>%s)::%s',key_count,pk.sql_type);
      key_count := key_count+1;
    end loop;
    if key_count=0 then raise exception 'EXPORT_SCHEMA_UNAVAILABLE' using errcode='55000'; end if;
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
    return result;
  end loop;
  return jsonb_build_object('format','tickit-tenant-export','schemaVersion',1,'collections',manifest,'readAt',statement_timestamp());
end;
$$;

revoke all on function public.tenant_export_spec() from public, anon;
revoke all on function public.can_export_tenant_data(uuid) from public, anon;
revoke all on function public.export_tenant_data(uuid,text,jsonb) from public, anon;
grant execute on function public.tenant_export_spec() to authenticated;
grant execute on function public.can_export_tenant_data(uuid) to authenticated;
grant execute on function public.export_tenant_data(uuid,text,jsonb) to authenticated;

create function public.can_export_tenant_file(p_bucket text,p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (p_bucket='product-images' and exists(select 1 from public.product_images i
    where i.storage_path=p_path and split_part(p_path,'/',1)=i.tenant_id::text and public.can_export_tenant_data(i.tenant_id)))
    or exists(select 1 from public.supplier_documents d where d.storage_bucket=p_bucket and d.storage_path=p_path
      and split_part(p_path,'/',1)=d.tenant_id::text and p_bucket='supplier-documents'
      and d.deleted_at is null and d.storage_deleted_at is null and public.can_export_tenant_data(d.tenant_id));
$$;
revoke all on function public.can_export_tenant_file(text,text) from public,anon;
grant execute on function public.can_export_tenant_file(text,text) to authenticated;

-- Owners retain access to their exportable files even if ordinary paid features
-- are suspended. This policy gives no access to another tenant or unrelated files.
create policy tenant_owner_export_files on storage.objects for select to authenticated using (
  public.can_export_tenant_file(bucket_id,name)
);
