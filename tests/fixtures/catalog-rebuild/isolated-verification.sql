\set ON_ERROR_STOP on

do $$
begin
  if (select count(*) from public.products where venue_id='11111111-1111-4111-8111-111111111111') <> 116 then raise exception 'PRODUCT_COUNT_MISMATCH'; end if;
  if (select count(*) from public.product_variants where venue_id='11111111-1111-4111-8111-111111111111') <> 217 then raise exception 'VARIANT_COUNT_MISMATCH'; end if;
  if (select count(*) from public.catalog_placements where venue_id='11111111-1111-4111-8111-111111111111') <> 213 then raise exception 'PLACEMENT_COUNT_MISMATCH'; end if;
  if exists (select 1 from public.products p left join public.product_variants v on v.product_id=p.id and v.is_active and v.is_default where p.venue_id='11111111-1111-4111-8111-111111111111' group by p.id having count(v.id)<>1) then raise exception 'DEFAULT_VARIANT_MISMATCH'; end if;
  if exists (select 1 from public.selection_group_options o join public.products p on p.id=o.product_id where o.venue_id='11111111-1111-4111-8111-111111111111' and p.product_type<>'standard') then raise exception 'NESTED_MENU'; end if;
end $$;

insert into public.venues(id,tenant_id,name,catalog_profile) values ('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Other isolated venue','custom') on conflict do nothing;
insert into public.categories(id,tenant_id,venue_id,name,sort_order,is_active,unused) values ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','Other category',10,true,false) on conflict do nothing;

do $$ declare v_tab uuid;
begin
  select id into v_tab from public.catalog_tabs where venue_id='11111111-1111-4111-8111-111111111111' limit 1;
  begin
    insert into public.catalog_tab_categories(tenant_id,venue_id,tab_id,category_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111',v_tab,'33333333-3333-4333-8333-333333333333');
    raise exception 'CROSS_VENUE_FK_WAS_ACCEPTED';
  exception when foreign_key_violation then null; end;
end $$;

insert into auth.users(id,email) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cashier@example.test') on conflict do nothing;
insert into public.tenant_memberships(tenant_id,user_id,role) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cashier') on conflict do nothing;
insert into public.devices(id,tenant_id,venue_id,name,device_mode) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','Isolated device','checkout') on conflict do nothing;
insert into public.device_user_assignments(tenant_id,user_id,venue_id,device_id) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd') on conflict do nothing;

begin;
select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
select set_config('request.jwt.claim.role','authenticated',true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.categories where venue_id='11111111-1111-4111-8111-111111111111') <> 10 then raise exception 'RLS_TARGET_NOT_VISIBLE'; end if;
  if (select count(*) from public.categories where venue_id='22222222-2222-4222-8222-222222222222') <> 0 then raise exception 'RLS_OTHER_VENUE_VISIBLE'; end if;
  if (select count(*) from public.selection_group_options where venue_id='11111111-1111-4111-8111-111111111111') <> 12 then raise exception 'RLS_CHILDREN_NOT_VISIBLE'; end if;
end $$;
rollback;

select set_config('request.jwt.claim.sub','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',false);
select set_config('request.jwt.claim.role','authenticated',false);
do $$ declare v_register uuid; v_product uuid; v_variant uuid;
begin
  select id into v_register from public.cash_registers where venue_id='11111111-1111-4111-8111-111111111111' and name='Isolated device';
  select p.id,v.id into v_product,v_variant from public.products p join public.product_variants v on v.product_id=p.id and v.is_active and v.is_default where p.venue_id='11111111-1111-4111-8111-111111111111' limit 1;
  insert into public.cash_sessions(id,tenant_id,venue_id,device_id,opened_by,status,cash_register_id,opened_by_device_id) values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','open',v_register,'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  insert into public.order_groups(id,tenant_id,venue_id,cash_session_id) values ('44444444-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  insert into public.orders(id,tenant_id,venue_id,cash_session_id,opened_by_user_id,opened_by_device_id,cash_register_id,order_group_id) values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','dddddddd-dddd-4ddd-8ddd-dddddddddddd',v_register,'44444444-4444-4444-8444-444444444444');
  insert into public.order_lines(id,tenant_id,venue_id,order_id,product_id,variant_id,product_name,variant_name,unit_price_cents,quantity) values ('ffffffff-ffff-4fff-8fff-ffffffffffff','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',v_product,v_variant,'Historical product','Historical variant',100,1);
  insert into public.tickets(id,tenant_id,cash_session_id,venue_id,device_id,user_id,status,subtotal_cents,total_cents,local_created_at,cash_register_id) values ('99999999-9999-4999-8999-999999999999','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','paid',100,100,now(),v_register);
  insert into public.ticket_lines(id,tenant_id,ticket_id,product_id,variant_id,product_name,variant_name,quantity,unit_price_cents,line_total_cents) values ('88888888-8888-4888-8888-888888888888','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','99999999-9999-4999-8999-999999999999',v_product,v_variant,'Historical product','Historical variant',1,100,100);
end $$;

select 'ISOLATED_VERIFICATION_OK' as result;
