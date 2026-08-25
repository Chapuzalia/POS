create or replace function public.delete_invoice_customer(
  p_tenant_id uuid,
  p_customer_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.user_has_tenant_access(p_tenant_id) then
    raise exception 'No tienes acceso a este negocio' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.tickets
    where tenant_id = p_tenant_id
      and customer_id = p_customer_id
  ) then
    raise exception 'CUSTOMER_HAS_INVOICES' using errcode = '23503';
  end if;

  delete from public.customers
  where tenant_id = p_tenant_id
    and id = p_customer_id;

  if not found then
    raise exception 'Cliente no encontrado' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.delete_invoice_customer(uuid, uuid) from public;
grant execute on function public.delete_invoice_customer(uuid, uuid) to authenticated;
