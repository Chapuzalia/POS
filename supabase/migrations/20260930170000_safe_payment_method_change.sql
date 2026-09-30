-- Safe, audited payment-method changes do not alter the fiscal document.
-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

-- The local-fiscal guard permits only the audited RPC below to change payment
-- method metadata. Amounts, ticket identity and fiscal snapshots remain frozen.
create or replace function public.guard_issued_local_fiscal_sale() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'tickets' then
      if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.ticket_id = old.id) then
        raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
      end if;
    elsif tg_table_name = 'sales' then
      if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.id) then
        raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
      end if;
    elsif tg_table_name = 'sale_payments' then
      if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.sale_id) then
        raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
      end if;
    end if;
    return old;
  end if;
  if tg_table_name = 'tickets' then
    if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.ticket_id = old.id)
      and ((new.status is distinct from old.status and coalesce(current_setting('app.local_fiscal_annulment', true), '') <> 'yes')
      or new.invoice_series is distinct from old.invoice_series
      or new.invoice_number is distinct from old.invoice_number
      or new.invoice_issued_at is distinct from old.invoice_issued_at
      or new.customer_snapshot is distinct from old.customer_snapshot) then
      raise exception 'LOCAL_FISCAL_INVOICE_IMMUTABLE' using errcode = '55000';
    end if;
  elsif tg_table_name = 'sales' then
    if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.id)
      and (new.total_cents is distinct from old.total_cents
      or new.payment_method is distinct from old.payment_method and coalesce(current_setting('app.payment_method_change', true), '') <> 'yes'
      or new.ticket_id is distinct from old.ticket_id) then
      raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
    end if;
  elsif tg_table_name = 'sale_payments' then
    if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.sale_id)
      and ((new.method is distinct from old.method and coalesce(current_setting('app.payment_method_change', true), '') <> 'yes')
      or new.amount_cents is distinct from old.amount_cents
      or new.received_cents is distinct from old.received_cents and coalesce(current_setting('app.payment_method_change', true), '') <> 'yes'
      or new.change_cents is distinct from old.change_cents and coalesce(current_setting('app.payment_method_change', true), '') <> 'yes') then
      raise exception 'LOCAL_FISCAL_PAYMENT_IMMUTABLE' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.change_sale_payment_method_safe(
  p_event_id uuid,
  p_tenant_id uuid,
  p_sale_id uuid,
  p_payment_id uuid,
  p_payment_method text,
  p_received_cents integer,
  p_change_cents integer,
  p_payload jsonb default '{}'::jsonb,
  p_cashlogy_request_id text default null,
  p_cashlogy_transaction_id text default null
) returns void
language plpgsql
set search_path = '' as $$
declare
  sale_row public.sales%rowtype;
  ticket_row public.tickets%rowtype;
  session_status text;
  payment_row public.sale_payments%rowtype;
  logged_event_id uuid;
begin
  if p_event_id is null or p_tenant_id is null or p_sale_id is null or p_payment_id is null then
    raise exception 'PAYMENT_METHOD_CHANGE_CONTEXT_REQUIRED' using errcode = '22023';
  end if;
  if p_payment_method not in ('cash', 'card') then
    raise exception 'PAYMENT_METHOD_INVALID' using errcode = '22023';
  end if;
  if p_payment_method = 'cash' and (p_received_cents is null or p_change_cents is null or p_received_cents < 0 or p_change_cents < 0) then
    raise exception 'PAYMENT_METHOD_CASH_AMOUNTS_INVALID' using errcode = '22023';
  end if;
  if p_payment_method = 'card' and (p_received_cents is not null or p_change_cents <> 0) then
    raise exception 'PAYMENT_METHOD_CARD_AMOUNTS_INVALID' using errcode = '22023';
  end if;
  if not public.user_has_tenant_access(p_tenant_id) then
    raise exception 'PAYMENT_METHOD_TENANT_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Lock in a stable order so closing a session cannot race this change.
  select * into sale_row from public.sales where id = p_sale_id and tenant_id = p_tenant_id for update;
  if sale_row.id is null then raise exception 'PAYMENT_METHOD_SALE_NOT_FOUND'; end if;
  select * into ticket_row from public.tickets where id = sale_row.ticket_id and tenant_id = p_tenant_id for update;
  if ticket_row.id is null or ticket_row.status = 'void' then raise exception 'PAYMENT_METHOD_TICKET_INVALID'; end if;
  select status into session_status from public.cash_sessions where id = sale_row.cash_session_id and tenant_id = p_tenant_id for update;
  if session_status is distinct from 'open' then raise exception 'PAYMENT_METHOD_CASH_SESSION_CLOSED'; end if;
  select * into payment_row from public.sale_payments where id = p_payment_id and sale_id = p_sale_id and tenant_id = p_tenant_id for update;
  if payment_row.id is null then raise exception 'PAYMENT_METHOD_PAYMENT_NOT_FOUND'; end if;

  insert into public.offline_event_log (tenant_id, event_kind, client_event_id, payload)
  values (p_tenant_id, 'sale_payment_changed', p_event_id,
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
      'audit', jsonb_build_object('saleId', p_sale_id, 'paymentId', p_payment_id,
        'previousMethod', payment_row.method, 'newMethod', p_payment_method,
        'changedBy', auth.uid(), 'changedAt', clock_timestamp())))
  on conflict (tenant_id, client_event_id) do nothing returning id into logged_event_id;
  if logged_event_id is null then return; end if;

  perform set_config('app.payment_method_change', 'yes', true);
  update public.sales set payment_method = p_payment_method where id = p_sale_id and tenant_id = p_tenant_id;
  update public.sale_payments set method = p_payment_method, received_cents = p_received_cents,
    change_cents = p_change_cents, cashlogy_request_id = p_cashlogy_request_id,
    cashlogy_transaction_id = p_cashlogy_transaction_id
    where id = p_payment_id and sale_id = p_sale_id and tenant_id = p_tenant_id;
end;
$$;

revoke all on function public.change_sale_payment_method_safe(uuid, uuid, uuid, uuid, text, integer, integer, jsonb, text, text) from public, anon;
grant execute on function public.change_sale_payment_method_safe(uuid, uuid, uuid, uuid, text, integer, integer, jsonb, text, text) to authenticated;
