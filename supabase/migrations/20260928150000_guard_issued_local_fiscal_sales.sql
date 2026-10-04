-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';

create function public.guard_issued_local_fiscal_sale() returns trigger
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
      and (new.status is distinct from old.status
      or new.invoice_series is distinct from old.invoice_series
      or new.invoice_number is distinct from old.invoice_number
      or new.invoice_issued_at is distinct from old.invoice_issued_at
      or new.customer_snapshot is distinct from old.customer_snapshot) then
      raise exception 'LOCAL_FISCAL_INVOICE_IMMUTABLE' using errcode = '55000';
    end if;
  elsif tg_table_name = 'sales' then
    if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.id)
      and (new.total_cents is distinct from old.total_cents
      or new.payment_method is distinct from old.payment_method
      or new.ticket_id is distinct from old.ticket_id) then
      raise exception 'LOCAL_FISCAL_SALE_IMMUTABLE' using errcode = '55000';
    end if;
  elsif tg_table_name = 'sale_payments' then
    if exists (select 1 from public.fiscal_local_records r where r.tenant_id = old.tenant_id and r.sale_id = old.sale_id)
      and (new.method is distinct from old.method or new.amount_cents is distinct from old.amount_cents) then
      raise exception 'LOCAL_FISCAL_PAYMENT_IMMUTABLE' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_issued_local_fiscal_ticket before update or delete on public.tickets
for each row execute function public.guard_issued_local_fiscal_sale();
create trigger guard_issued_local_fiscal_sale before update or delete on public.sales
for each row execute function public.guard_issued_local_fiscal_sale();
create trigger guard_issued_local_fiscal_payment before update or delete on public.sale_payments
for each row execute function public.guard_issued_local_fiscal_sale();
