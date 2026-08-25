-- A physical Cashlogy transaction may back exactly one POS payment.

alter table public.sale_payments
  add column if not exists cashlogy_request_id text,
  add column if not exists cashlogy_transaction_id text;

alter table public.sale_payments
  drop constraint if exists sale_payments_cashlogy_identity_complete;

alter table public.sale_payments
  add constraint sale_payments_cashlogy_identity_complete check (
    (cashlogy_request_id is null and cashlogy_transaction_id is null)
    or (
      method = 'cash'
      and nullif(btrim(cashlogy_request_id), '') is not null
      and nullif(btrim(cashlogy_transaction_id), '') is not null
    )
  );

create unique index if not exists sale_payments_cashlogy_request_unique
  on public.sale_payments (tenant_id, cashlogy_request_id)
  where cashlogy_request_id is not null;

create unique index if not exists sale_payments_cashlogy_transaction_unique
  on public.sale_payments (tenant_id, cashlogy_transaction_id)
  where cashlogy_transaction_id is not null;

create or replace function public.apply_cashlogy_identity_from_sale_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment_payload jsonb;
begin
  if new.cashlogy_request_id is not null or new.cashlogy_transaction_id is not null then
    return new;
  end if;

  select event.payload -> 'payment'
  into payment_payload
  from public.offline_event_log event
  where event.tenant_id = new.tenant_id
    and event.event_kind = 'sale_created'
    and event.payload -> 'sale' ->> 'id' = new.sale_id::text
  order by event.created_at desc
  limit 1;

  if jsonb_typeof(payment_payload) = 'object'
    and nullif(btrim(payment_payload ->> 'cashlogyRequestId'), '') is not null
    and nullif(btrim(payment_payload ->> 'cashlogyTransactionId'), '') is not null then
    new.cashlogy_request_id := payment_payload ->> 'cashlogyRequestId';
    new.cashlogy_transaction_id := payment_payload ->> 'cashlogyTransactionId';
  end if;

  return new;
end;
$$;

drop trigger if exists apply_cashlogy_identity_from_sale_event_before_insert on public.sale_payments;
create trigger apply_cashlogy_identity_from_sale_event_before_insert
before insert on public.sale_payments
for each row execute function public.apply_cashlogy_identity_from_sale_event();

create or replace function public.attach_cashlogy_identity_to_payment_result(
  p_result jsonb,
  p_cashlogy_request_id text,
  p_cashlogy_transaction_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  sale_id_value uuid;
begin
  if nullif(btrim(p_cashlogy_request_id), '') is null
    or nullif(btrim(p_cashlogy_transaction_id), '') is null then
    raise exception 'CASHLOGY_PAYMENT_IDENTITY_REQUIRED';
  end if;

  if coalesce((p_result ->> 'requiresConfirmation')::boolean, false) then
    return p_result;
  end if;

  sale_id_value := nullif(p_result ->> 'saleId', '')::uuid;
  if sale_id_value is null then
    raise exception 'CASHLOGY_PAYMENT_SALE_NOT_FOUND';
  end if;

  update public.sale_payments payment
  set cashlogy_request_id = p_cashlogy_request_id,
      cashlogy_transaction_id = p_cashlogy_transaction_id
  where payment.sale_id = sale_id_value
    and payment.method = 'cash';

  if not found then
    raise exception 'CASHLOGY_PAYMENT_SALE_NOT_FOUND';
  end if;

  return p_result;
exception
  when unique_violation then
    raise exception 'CASHLOGY_PAYMENT_ALREADY_REGISTERED' using errcode = '23505';
end;
$$;

revoke all on function public.attach_cashlogy_identity_to_payment_result(jsonb, text, text) from public;

create or replace function public.close_restaurant_order_cashlogy(
  p_order_id uuid,
  p_payment_method text,
  p_received_cents integer,
  p_allow_pending boolean,
  p_discount jsonb,
  p_cashlogy_request_id text,
  p_cashlogy_transaction_id text,
  p_customer_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_payment_method is distinct from 'cash' then
    raise exception 'CASHLOGY_PAYMENT_METHOD_INVALID';
  end if;

  result := case when p_customer_id is null
    then public.close_restaurant_order_checked_v2(
      p_order_id, p_payment_method, p_received_cents, p_allow_pending, p_discount
    )
    else public.close_restaurant_order_with_invoice(
      p_order_id, p_payment_method, p_received_cents, p_allow_pending, p_discount, p_customer_id
    )
  end;

  return public.attach_cashlogy_identity_to_payment_result(
    result, p_cashlogy_request_id, p_cashlogy_transaction_id
  );
end;
$$;

create or replace function public.pay_restaurant_order_items_cashlogy(
  p_order_id uuid,
  p_expected_revision integer,
  p_items jsonb,
  p_payment_method text,
  p_received_cents integer,
  p_allow_pending boolean,
  p_discount jsonb,
  p_cashlogy_request_id text,
  p_cashlogy_transaction_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_payment_method is distinct from 'cash' then
    raise exception 'CASHLOGY_PAYMENT_METHOD_INVALID';
  end if;

  result := public.pay_restaurant_order_items(
    p_order_id, p_expected_revision, p_items, p_payment_method,
    p_received_cents, p_allow_pending, p_discount
  );
  return public.attach_cashlogy_identity_to_payment_result(
    result, p_cashlogy_request_id, p_cashlogy_transaction_id
  );
end;
$$;

create or replace function public.pay_restaurant_order_equal_part_cashlogy(
  p_split_id uuid,
  p_payment_method text,
  p_received_cents integer,
  p_allow_pending boolean,
  p_discount jsonb,
  p_use_default_discount boolean,
  p_cashlogy_request_id text,
  p_cashlogy_transaction_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_payment_method is distinct from 'cash' then
    raise exception 'CASHLOGY_PAYMENT_METHOD_INVALID';
  end if;

  result := public.pay_restaurant_order_equal_part(
    p_split_id, p_payment_method, p_received_cents, p_allow_pending,
    p_discount, p_use_default_discount
  );
  return public.attach_cashlogy_identity_to_payment_result(
    result, p_cashlogy_request_id, p_cashlogy_transaction_id
  );
end;
$$;

revoke all on function public.close_restaurant_order_cashlogy(uuid, text, integer, boolean, jsonb, text, text, uuid) from public;
revoke all on function public.pay_restaurant_order_items_cashlogy(uuid, integer, jsonb, text, integer, boolean, jsonb, text, text) from public;
revoke all on function public.pay_restaurant_order_equal_part_cashlogy(uuid, text, integer, boolean, jsonb, boolean, text, text) from public;

grant execute on function public.close_restaurant_order_cashlogy(uuid, text, integer, boolean, jsonb, text, text, uuid) to authenticated;
grant execute on function public.pay_restaurant_order_items_cashlogy(uuid, integer, jsonb, text, integer, boolean, jsonb, text, text) to authenticated;
grant execute on function public.pay_restaurant_order_equal_part_cashlogy(uuid, text, integer, boolean, jsonb, boolean, text, text) to authenticated;

create or replace function public.change_sale_payment_method_cashlogy(
  p_sale_id uuid,
  p_payment_id uuid,
  p_received_cents integer,
  p_change_cents integer,
  p_cashlogy_request_id text,
  p_cashlogy_transaction_id text
) returns void
language plpgsql
set search_path = ''
as $$
begin
  if nullif(btrim(p_cashlogy_request_id), '') is null
    or nullif(btrim(p_cashlogy_transaction_id), '') is null then
    raise exception 'CASHLOGY_PAYMENT_IDENTITY_REQUIRED';
  end if;

  update public.sales sale
  set payment_method = 'cash'
  where sale.id = p_sale_id;
  if not found then raise exception 'CASHLOGY_PAYMENT_SALE_NOT_FOUND'; end if;

  update public.sale_payments payment
  set method = 'cash',
      received_cents = p_received_cents,
      change_cents = p_change_cents,
      cashlogy_request_id = p_cashlogy_request_id,
      cashlogy_transaction_id = p_cashlogy_transaction_id
  where payment.id = p_payment_id
    and payment.sale_id = p_sale_id;
  if not found then raise exception 'CASHLOGY_PAYMENT_SALE_NOT_FOUND'; end if;
exception
  when unique_violation then
    raise exception 'CASHLOGY_PAYMENT_ALREADY_REGISTERED' using errcode = '23505';
end;
$$;

revoke all on function public.change_sale_payment_method_cashlogy(uuid, uuid, integer, integer, text, text) from public;
grant execute on function public.change_sale_payment_method_cashlogy(uuid, uuid, integer, integer, text, text) to authenticated;
