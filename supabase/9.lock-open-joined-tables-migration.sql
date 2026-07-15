-- Una composicion con una comanda abierta no puede separarse ni reagruparse.
begin;

create or replace function public.validate_cash_session_table_layout_compactness()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.validate_compact_joined_table_layout(new.tables);

  if tg_op = 'UPDATE' and exists (
    with protected_groups as (
      select distinct old_item.value ->> 'groupId' as group_id
      from jsonb_each(old.tables) old_item
      join public.order_tables ot
        on ot.table_id = old_item.key::uuid
        and ot.released_at is null
      join public.orders o
        on o.id = ot.order_id
        and o.cash_session_id = new.cash_session_id
        and o.status = 'open'
      where nullif(old_item.value ->> 'groupId', '') is not null
    )
    select 1
    from jsonb_each(old.tables) old_item
    where (old_item.value ->> 'groupId')
        is distinct from ((new.tables -> old_item.key) ->> 'groupId')
      and exists (
        select 1
        from protected_groups protected
        where protected.group_id = (old_item.value ->> 'groupId')
          or protected.group_id = ((new.tables -> old_item.key) ->> 'groupId')
      )
  ) then
    raise exception 'No se pueden separar mesas con una comanda abierta'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_cash_session_table_layout_compactness() from public;

commit;
