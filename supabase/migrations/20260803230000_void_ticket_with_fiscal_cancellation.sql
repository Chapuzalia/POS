-- A fiscal ticket is never physically deleted. This service-role-only helper
-- performs the local void after Verifacti has accepted the cancellation request.

create or replace function public.finalize_ticket_void(
  p_tenant_id uuid,
  p_ticket_id uuid,
  p_actor_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.tickets%rowtype;
  v_invoice public.fiscal_invoices%rowtype;
  v_equal_payment public.restaurant_order_equal_split_payments%rowtype;
begin
  select * into v_ticket
  from public.tickets
  where tenant_id = p_tenant_id and id = p_ticket_id
  for update;

  if v_ticket.id is null then
    raise exception 'Ticket no encontrado' using errcode = 'P0002';
  end if;

  if v_ticket.status = 'void' then
    return;
  end if;

  select * into v_invoice
  from public.fiscal_invoices
  where tenant_id = p_tenant_id and ticket_id = p_ticket_id
  for update;

  if v_invoice.id is not null
    and v_invoice.status <> 'cancelled'
    and v_invoice.pending_operation <> 'cancel' then
    raise exception 'FISCAL_CANCELLATION_REQUIRED: la anulacion fiscal no se ha solicitado'
      using errcode = '55000';
  end if;

  -- An equal-split payment owns a restrictive reference to its sale. Reverse
  -- its progress before removing the financial rows for the voided ticket.
  for v_equal_payment in
    select rep.*
    from public.restaurant_order_equal_split_payments rep
    join public.sales s on s.id = rep.sale_id
    where s.tenant_id = p_tenant_id and s.ticket_id = p_ticket_id
    order by rep.created_at desc, rep.id
    for update of rep
  loop
    update public.restaurant_order_equal_splits
    set paid_parts = greatest(paid_parts - 1, 0),
        paid_cents = greatest(paid_cents - v_equal_payment.subtotal_cents, 0),
        status = 'open',
        completed_at = null,
        revision = revision + 1,
        updated_at = now()
    where id = v_equal_payment.split_id;

    update public.orders o
    set status = 'open',
        closed_at = null,
        revision = revision + 1,
        updated_at = now()
    from public.restaurant_order_equal_splits s
    where s.id = v_equal_payment.split_id
      and o.id = s.order_id
      and o.status = 'paid';

    delete from public.restaurant_order_equal_split_payments
    where id = v_equal_payment.id;
  end loop;

  if v_invoice.id is not null then
    update public.fiscal_invoices
    set sale_id = null,
        updated_at = now()
    where id = v_invoice.id;
  end if;

  delete from public.sale_payments sp
  using public.sales s
  where sp.sale_id = s.id
    and s.tenant_id = p_tenant_id
    and s.ticket_id = p_ticket_id;

  delete from public.sales
  where tenant_id = p_tenant_id and ticket_id = p_ticket_id;

  update public.tickets
  set status = 'void'
  where tenant_id = p_tenant_id and id = p_ticket_id;

  if v_invoice.id is not null then
    insert into public.fiscal_invoice_events (
      tenant_id, venue_id, fiscal_invoice_id, source, event_type, status, payload
    ) values (
      p_tenant_id, v_invoice.venue_id, v_invoice.id, 'user', 'ticket_voided',
      case when v_invoice.pending_operation = 'cancel' then 'pending' else 'cancelled' end,
      jsonb_build_object(
        'ticket_id', p_ticket_id,
        'actor_id', p_actor_id,
        'cancellation_pending', v_invoice.pending_operation = 'cancel'
      )
    );
  end if;
end;
$$;

revoke all on function public.finalize_ticket_void(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_ticket_void(uuid, uuid, uuid) to service_role;

