\set ON_ERROR_STOP on

-- This fixture starts after migration 41. It makes the historical demo data
-- unambiguous, adds residual bridge rows, and then executes migration 42.
update public.tenants set max_venues=3 where id='11111111-1111-1111-1111-111111111111';
update public.categories c set venue_id=(
  select p.venue_id from public.products p where p.category_id=c.id order by p.venue_id::text limit 1
) where c.venue_id is null;

insert into public.tenants(id,name,slug,max_venues)
values('a0000000-0000-4000-8000-000000000001','Other tenant','phase4-other',2) on conflict do nothing;
insert into public.venues(id,tenant_id,name,catalog_profile) values
  ('a0000000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','Second venue','custom'),
  ('a0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001','Other tenant venue','custom')
on conflict do nothing;

-- Simulate a pre-final category that never acquired venue scope.
alter table public.categories disable trigger categories_catalog_validate;
insert into public.categories(id,tenant_id,venue_id,name,kind,sort_order,is_active)
values('a2300000-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111',null,'Invalid unscoped category','other',999,true);
alter table public.categories enable trigger categories_catalog_validate;

insert into public.selection_groups(id,tenant_id,venue_id,kind,name,min_select,max_select,is_active,sort_order)
values('a1000000-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','mixer','Fixture mixer',1,1,true,10);
insert into public.selection_group_options(id,tenant_id,venue_id,group_id,product_id,supplement_cents,default_quantity,max_quantity,is_active,sort_order)
values('a1000000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a1000000-0000-4000-8000-000000000001','44444444-4444-4444-4444-444444444443',0,1,1,true,10);
insert into public.product_selection_group_assignments(id,tenant_id,venue_id,product_id,group_id,min_selection,max_selection,applies_to_all_variants,is_active,sort_order)
values('a1000000-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444441','a1000000-0000-4000-8000-000000000001',1,1,true,true,10);

do $$ declare v_category uuid; v_tab uuid; v_component uuid; v_component_variant uuid;
begin
  select id into v_category from public.categories where venue_id='22222222-2222-2222-2222-222222222222' order by sort_order limit 1;
  select id into v_tab from public.catalog_tabs where venue_id='22222222-2222-2222-2222-222222222222' order by sort_order limit 1;
  select p.id,v.id into v_component,v_component_variant from public.products p
  join public.product_variants v on v.product_id=p.id and v.is_active and v.is_default
  where p.id='44444444-4444-4444-4444-444444444444';

  insert into public.products(id,tenant_id,venue_id,name,product_type,tax_rate,is_active,sort_order)
  values('a2000000-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','Fixture menu','menu',10,true,90);
  insert into public.product_variants(id,tenant_id,venue_id,product_id,name,price_cents,is_default,is_active,sort_order)
  values('a2000000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a2000000-0000-4000-8000-000000000001','Complete',1500,true,true,10);
  insert into public.catalog_placements(id,tenant_id,venue_id,tab_id,category_id,product_id,default_variant_id,is_featured,is_active,sort_order)
  values('a2000000-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',v_tab,v_category,'a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002',true,true,90);
  insert into public.selection_groups(id,tenant_id,venue_id,kind,name,min_select,max_select,is_active,sort_order)
  values('a2000000-0000-4000-8000-000000000004','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','menu_component','Main',1,1,true,20);
  insert into public.selection_group_items(id,tenant_id,group_id,product_id,variant_id,price_delta_cents,is_default,is_active,sort_order)
  values('a2000000-0000-4000-8000-000000000005','11111111-1111-1111-1111-111111111111','a2000000-0000-4000-8000-000000000004',v_component,v_component_variant,100,true,true,10);
  -- Regression: an active internal product can still exist only in the legacy
  -- bridge at preflight time; migration 42 converts it into the final option.
  insert into public.products(id,tenant_id,venue_id,name,product_type,tax_rate,is_active,sort_order)
  values('a2100000-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','Legacy-only internal option','standard',10,true,91);
  insert into public.product_variants(id,tenant_id,venue_id,product_id,name,price_cents,is_default,is_active,sort_order)
  values('a2100000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a2100000-0000-4000-8000-000000000001','Default',0,true,true,10);
  insert into public.selection_group_items(id,tenant_id,group_id,product_id,variant_id,price_delta_cents,is_default,is_active,sort_order)
  values('a2100000-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111','a2000000-0000-4000-8000-000000000004','a2100000-0000-4000-8000-000000000001','a2100000-0000-4000-8000-000000000002',0,false,true,20);
  -- Final-domain regression: products without active placements are legitimate
  -- internal products even when no selection group currently references them.
  insert into public.products(id,tenant_id,venue_id,name,product_type,tax_rate,is_active,sort_order)
  values('a2200000-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','Unassigned internal product','standard',10,true,92);
  insert into public.product_variants(id,tenant_id,venue_id,product_id,name,price_cents,is_default,is_active,sort_order)
  values('a2200000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a2200000-0000-4000-8000-000000000001','Default',0,true,true,10);
  insert into public.variant_selection_groups(tenant_id,variant_id,selection_group_id,sort_order)
  values('11111111-1111-1111-1111-111111111111','a2000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000004',10);
end $$;

insert into public.product_images(id,tenant_id,venue_id,product_id,storage_path,mime_type,size_bytes,sha256)
values('a3000000-0000-4000-8000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a2000000-0000-4000-8000-000000000001','phase4/menu.png','image/png',8,repeat('a',64));
insert into public.modifier_groups(id,tenant_id,venue_id,product_id,name,min_select,max_select,is_active,sort_order)
values('a3000000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a2000000-0000-4000-8000-000000000001','Extras',0,2,true,10);
insert into public.modifiers(id,tenant_id,venue_id,group_id,name,price_cents,supplement_cents,is_default,is_active,sort_order)
values('a3000000-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a3000000-0000-4000-8000-000000000002','Cheese',25,25,false,true,10);
insert into public.product_modifier_groups(tenant_id,product_id,variant_id,modifier_group_id,sort_order)
values('11111111-1111-1111-1111-111111111111','a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000002',10);

\ir /tmp/supabase/42.catalog-final-legacy-cleanup.sql

-- Historical order/ticket snapshots are created after cleanup to prove that no
-- live catalogue lookup or foreign key is required for their presentation.
insert into auth.users(id,email) values('a4000000-0000-4000-8000-000000000001','phase4@example.test') on conflict do nothing;
insert into public.tenant_memberships(tenant_id,user_id,role) values('11111111-1111-1111-1111-111111111111','a4000000-0000-4000-8000-000000000001','cashier') on conflict do nothing;
insert into public.devices(id,tenant_id,venue_id,name,device_mode,can_take_orders,can_take_payments,can_open_cash_session,can_close_cash_session,can_manage_cash)
values('a4000000-0000-4000-8000-000000000002','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','Phase4 device','checkout',true,true,true,true,true) on conflict do nothing;
insert into public.device_user_assignments(tenant_id,user_id,venue_id,device_id)
values('11111111-1111-1111-1111-111111111111','a4000000-0000-4000-8000-000000000001','22222222-2222-2222-2222-222222222222','a4000000-0000-4000-8000-000000000002') on conflict do nothing;
select set_config('request.jwt.claim.sub','a4000000-0000-4000-8000-000000000001',false);
select set_config('request.jwt.claim.role','authenticated',false);

do $$ declare v_tab uuid; v_category uuid;
begin
  perform set_config('request.jwt.claim.role','service_role',true);
  select id into v_tab from public.catalog_tabs where venue_id='22222222-2222-2222-2222-222222222222' order by sort_order limit 1;
  select id into v_category from public.categories where venue_id='22222222-2222-2222-2222-222222222222' order by sort_order limit 1;
  perform public.catalog_command('22222222-2222-2222-2222-222222222222','create_product',
    '{"id":"b1000000-0000-4000-8000-000000000001","name":"Post cleanup product","type":"standard","vatRate":10,"active":true,"sortOrder":95,"variants":[{"id":"b1000000-0000-4000-8000-000000000002","name":"Default","priceCents":500,"isDefault":true,"active":true,"sortOrder":10}]}'::jsonb);
  perform public.catalog_command('22222222-2222-2222-2222-222222222222','update_variant',
    '{"id":"b1000000-0000-4000-8000-000000000002","productId":"b1000000-0000-4000-8000-000000000001","priceCents":550}'::jsonb);
  perform public.catalog_command('22222222-2222-2222-2222-222222222222','create_placement',
    jsonb_build_object('id','b1000000-0000-4000-8000-000000000003','productId','b1000000-0000-4000-8000-000000000001','tabId',v_tab,'categoryId',v_category,'pinnedVariantId','b1000000-0000-4000-8000-000000000002','featured',true,'active',true,'sortOrder',95));
  perform public.catalog_command('22222222-2222-2222-2222-222222222222','save_selection_group',
    '{"id":"b1000000-0000-4000-8000-000000000004","type":"mixer","name":"Post cleanup mixer","active":true,"sortOrder":95}'::jsonb);
  perform public.catalog_command('22222222-2222-2222-2222-222222222222','save_modifier_group',
    '{"id":"b1000000-0000-4000-8000-000000000005","name":"Post cleanup extras","active":true,"sortOrder":95}'::jsonb);
  perform public.catalog_command('22222222-2222-2222-2222-222222222222','save_modifier',
    '{"id":"b1000000-0000-4000-8000-000000000006","groupId":"b1000000-0000-4000-8000-000000000005","name":"Post cleanup modifier","supplementCents":25,"isDefault":false,"active":true,"sortOrder":10}'::jsonb);
  if not exists(select 1 from public.product_variants where id='b1000000-0000-4000-8000-000000000002' and price_cents=550) then raise exception 'FINAL_CATALOG_COMMANDS_FAILED'; end if;
end $$;

do $$ declare v_register uuid;
begin
  select id into v_register from public.cash_registers where venue_id='22222222-2222-2222-2222-222222222222' and name='Phase4 device';
  insert into public.cash_sessions(id,tenant_id,venue_id,device_id,opened_by,status,cash_register_id,opened_by_device_id)
  values('a4000000-0000-4000-8000-000000000003','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a4000000-0000-4000-8000-000000000002','a4000000-0000-4000-8000-000000000001','open',v_register,'a4000000-0000-4000-8000-000000000002');
  insert into public.order_groups(id,tenant_id,venue_id,cash_session_id)
  values('a4000000-0000-4000-8000-000000000004','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a4000000-0000-4000-8000-000000000003');
  insert into public.orders(id,tenant_id,venue_id,cash_session_id,opened_by_user_id,opened_by_device_id,cash_register_id,order_group_id,status,closed_at)
  values('a4000000-0000-4000-8000-000000000005','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a4000000-0000-4000-8000-000000000003','a4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002',v_register,'a4000000-0000-4000-8000-000000000004','paid',now());
  insert into public.order_lines(id,tenant_id,venue_id,order_id,product_id,variant_id,product_name,variant_name,unit_price_cents,quantity,modifiers,components,catalog_snapshot)
  values('a4000000-0000-4000-8000-000000000006','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','a4000000-0000-4000-8000-000000000005',null,null,'Deleted menu','Complete',1625,1,'[{"name":"Cheese","priceCents":25}]','[]','{"productName":"Deleted menu","variantName":"Complete","categoryName":"Food","catalogTabName":"Menus"}');
  insert into public.tickets(id,tenant_id,cash_session_id,venue_id,device_id,user_id,status,subtotal_cents,total_cents,local_created_at,cash_register_id)
  values('a4000000-0000-4000-8000-000000000007','11111111-1111-1111-1111-111111111111','a4000000-0000-4000-8000-000000000003','22222222-2222-2222-2222-222222222222','a4000000-0000-4000-8000-000000000002','a4000000-0000-4000-8000-000000000001','paid',1625,1625,now(),v_register);
  insert into public.ticket_lines(id,tenant_id,ticket_id,product_id,variant_id,product_name,variant_name,quantity,unit_price_cents,line_total_cents,modifiers,category_name_snapshot,catalog_tab_name_snapshot)
  values('a4000000-0000-4000-8000-000000000008','11111111-1111-1111-1111-111111111111','a4000000-0000-4000-8000-000000000007','a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002','Deleted menu','Complete',1,1625,1625,'[{"name":"Cheese","priceCents":25}]','Food','Menus');
  insert into public.ticket_line_components(id,tenant_id,ticket_line_id,component_type,selection_group_name_snapshot,product_name_snapshot,variant_name_snapshot,quantity,price_delta_cents,metadata)
  values('a4000000-0000-4000-8000-000000000009','11111111-1111-1111-1111-111111111111','a4000000-0000-4000-8000-000000000008','menu_component','Main','Deleted component','Default',1,100,'{"modifiers":[{"name":"Salt","priceCents":0}]}');

  if not exists(select 1 from public.product_modifier_group_assignments where product_id='a2000000-0000-4000-8000-000000000001') then
    raise exception 'RESIDUAL_MODIFIER_NOT_CONVERTED';
  end if;

  -- The live catalogue rows disappear, while their immutable order/ticket
  -- snapshots and fiscal values remain without a required live catalogue FK.
  delete from public.products where id='a2000000-0000-4000-8000-000000000001';
end $$;

do $$ declare v_payload jsonb; v_object text;
begin
  if to_regclass('public.sale_formats') is not null or to_regclass('public.selection_group_items') is not null then raise exception 'LEGACY_RELATION_REMAINS'; end if;
  if exists(select 1 from public.categories where id='a2300000-0000-4000-8000-000000000001') then raise exception 'INVALID_SCOPE_CATEGORY_NOT_REMOVED'; end if;
  if exists(select 1 from information_schema.columns where table_schema='public' and column_name in('default_variant_id','can_use_as_mixer','mixer_supplement_cents')) then raise exception 'LEGACY_COLUMN_REMAINS'; end if;
  if not exists(select 1 from public.selection_group_options where id='a2000000-0000-4000-8000-000000000005' and supplement_cents=100) then raise exception 'RESIDUAL_SELECTION_NOT_CONVERTED'; end if;
  if not exists(select 1 from public.selection_group_options where id='a2100000-0000-4000-8000-000000000003' and product_id='a2100000-0000-4000-8000-000000000001' and variant_id='a2100000-0000-4000-8000-000000000002' and is_active) then raise exception 'LEGACY_ONLY_INTERNAL_OPTION_NOT_CONVERTED'; end if;
  if exists(select 1 from public.products where id='a2200000-0000-4000-8000-000000000001')
    or exists(select 1 from public.product_variants where product_id='a2200000-0000-4000-8000-000000000001')
  then raise exception 'UNASSIGNED_RESIDUAL_PRODUCT_NOT_REMOVED'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  select public.get_catalog('22222222-2222-2222-2222-222222222222','admin') into v_payload;
  if jsonb_array_length(v_payload->'products')=0 then raise exception 'FINAL_CATALOG_READ_FAILED'; end if;
  select public.get_catalog('22222222-2222-2222-2222-222222222222','pos') into v_payload;
  if not exists(select 1 from jsonb_array_elements(v_payload->'products') p where p->>'id'='b1000000-0000-4000-8000-000000000001') then raise exception 'FINAL_POS_READ_FAILED'; end if;
  if exists(select 1 from public.products where id='a2000000-0000-4000-8000-000000000001') or not exists(select 1 from public.ticket_lines where id='a4000000-0000-4000-8000-000000000008' and product_name='Deleted menu' and tax_rate=10 and taxable_base_cents=1477 and tax_amount_cents=148) then raise exception 'HISTORY_SNAPSHOT_FAILED'; end if;
  if not exists(select 1 from public.ticket_line_components where ticket_line_id='a4000000-0000-4000-8000-000000000008' and product_name_snapshot='Deleted component' and metadata->'modifiers'->0->>'name'='Salt') then raise exception 'PRINT_SNAPSHOT_FAILED'; end if;
  select p.oid::regprocedure::text into v_object from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~ '(selection_group_items|variant_selection_groups|product_modifier_groups|default_variant_id|can_use_as_mixer)' limit 1;
  if v_object is not null then raise exception 'FINAL_FUNCTION_LEGACY_REFERENCE: %',v_object; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in('products','product_variants','categories','catalog_tabs','catalog_placements','selection_groups','selection_group_options','modifier_groups','modifiers','product_images') and not c.relrowsecurity) then raise exception 'FINAL_RLS_DISABLED'; end if;
  if not has_table_privilege('authenticated','public.products','SELECT') or has_table_privilege('anon','public.products','INSERT') then raise exception 'FINAL_GRANTS_INVALID'; end if;
  begin
    insert into public.catalog_tab_categories(tenant_id,venue_id,tab_id,category_id)
    select '11111111-1111-1111-1111-111111111111','a0000000-0000-4000-8000-000000000002',t.id,c.id
    from public.catalog_tabs t cross join public.categories c
    where t.venue_id='22222222-2222-2222-2222-222222222222' and c.venue_id='22222222-2222-2222-2222-222222222222' limit 1;
    raise exception 'CROSS_VENUE_WRITE_ACCEPTED';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.catalog_tab_categories(tenant_id,venue_id,tab_id,category_id)
    select 'a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000003',t.id,c.id
    from public.catalog_tabs t cross join public.categories c
    where t.venue_id='22222222-2222-2222-2222-222222222222' and c.venue_id='22222222-2222-2222-2222-222222222222' limit 1;
    raise exception 'CROSS_TENANT_WRITE_ACCEPTED';
  exception when foreign_key_violation then null; end;
end $$;

select 'PHASE4_ISOLATED_OK' as status;
