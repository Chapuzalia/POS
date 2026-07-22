\set ON_ERROR_STOP on
do $$
begin
  if not exists (select 1 from public.orders where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' and status='open') then raise exception 'OPEN_ORDER_LOST'; end if;
  if not exists (select 1 from public.order_lines where id='ffffffff-ffff-4fff-8fff-ffffffffffff' and product_id is not null and variant_id is not null) then raise exception 'OPEN_ORDER_LINE_SNAPSHOT_LOST'; end if;
  if not exists (select 1 from public.tickets where id='99999999-9999-4999-8999-999999999999') then raise exception 'TICKET_LOST'; end if;
  if not exists (select 1 from public.ticket_lines where id='88888888-8888-4888-8888-888888888888' and product_id is not null and variant_id is not null) then raise exception 'TICKET_LINE_SNAPSHOT_LOST'; end if;
  if (select count(*) from public.products where venue_id='11111111-1111-4111-8111-111111111111') <> 116 then raise exception 'PRODUCT_COUNT_AFTER_REPLACE'; end if;
  if exists (select 1 from public.products where venue_id='22222222-2222-4222-8222-222222222222') then raise exception 'OTHER_VENUE_CHANGED'; end if;
end $$;
select 'POST_REPLACE_VERIFICATION_OK' as result;
