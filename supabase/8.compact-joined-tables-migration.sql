-- Garantiza que una composicion de mesas sea compacta incluso ante clientes antiguos.
begin;

create or replace function public.validate_compact_joined_table_layout(p_tables jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  group_key text;
  member_count integer;
  reached_count integer;
begin
  if p_tables is null or jsonb_typeof(p_tables) <> 'object' then
    raise exception 'Distribucion de mesas no valida';
  end if;

  -- Una composicion no puede solaparse consigo misma ni con otra mesa.
  if exists (
    with entries as (
      select item.key as table_id,
        nullif(item.value ->> 'groupId', '') as group_id,
        rt.area_id,
        (item.value ->> 'positionX')::numeric as x,
        (item.value ->> 'positionY')::numeric as y,
        rt.width::numeric as width,
        rt.height::numeric as height
      from jsonb_each(p_tables) item
      join public.restaurant_tables rt on rt.id = item.key::uuid
    )
    select 1
    from entries a
    join entries b on a.table_id < b.table_id
    where a.area_id = b.area_id
      and (a.group_id is not null or b.group_id is not null)
      and least(a.x + a.width, b.x + b.width) - greatest(a.x, b.x) > 0.08
      and least(a.y + a.height, b.y + b.height) - greatest(a.y, b.y) > 0.08
  ) then
    raise exception 'Las mesas juntadas no pueden solaparse con otras mesas';
  end if;

  if exists (
    select 1
    from jsonb_each(p_tables) item
    join public.restaurant_tables rt on rt.id = item.key::uuid
    where nullif(item.value ->> 'groupId', '') is not null
    group by item.value ->> 'groupId'
    having count(distinct rt.area_id) > 1
  ) then
    raise exception 'No se pueden juntar mesas de zonas distintas';
  end if;

  for group_key in
    select distinct nullif(item.value ->> 'groupId', '')
    from jsonb_each(p_tables) item
    where nullif(item.value ->> 'groupId', '') is not null
  loop
    with recursive members as (
      select item.key as table_id,
        (item.value ->> 'positionX')::numeric as x,
        (item.value ->> 'positionY')::numeric as y,
        rt.width::numeric as width,
        rt.height::numeric as height
      from jsonb_each(p_tables) item
      join public.restaurant_tables rt on rt.id = item.key::uuid
      where item.value ->> 'groupId' = group_key
    ), connected(table_id) as (
      select min(m.table_id) from members m
      union
      select candidate.table_id
      from connected reached
      join members current_member on current_member.table_id = reached.table_id
      join members candidate on candidate.table_id <> current_member.table_id
      where (
        (
          (abs((current_member.x + current_member.width) - candidate.x) <= 0.30
            or abs((candidate.x + candidate.width) - current_member.x) <= 0.30)
          and least(current_member.y + current_member.height, candidate.y + candidate.height)
            - greatest(current_member.y, candidate.y) > 0.20
        ) or (
          (abs((current_member.y + current_member.height) - candidate.y) <= 0.30
            or abs((candidate.y + candidate.height) - current_member.y) <= 0.30)
          and least(current_member.x + current_member.width, candidate.x + candidate.width)
            - greatest(current_member.x, candidate.x) > 0.20
        )
      )
    )
    select (select count(*) from members), (select count(distinct table_id) from connected)
    into member_count, reached_count;

    if member_count < 2 or reached_count <> member_count then
      raise exception 'Las mesas juntadas deben permanecer fisicamente pegadas';
    end if;
  end loop;
end;
$$;

create or replace function public.validate_cash_session_table_layout_compactness()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.validate_compact_joined_table_layout(new.tables);
  return new;
end;
$$;

drop trigger if exists validate_cash_session_table_layout_compactness
on public.cash_session_table_layouts;
create trigger validate_cash_session_table_layout_compactness
before insert or update of tables on public.cash_session_table_layouts
for each row execute function public.validate_cash_session_table_layout_compactness();

revoke all on function public.validate_compact_joined_table_layout(jsonb) from public;
revoke all on function public.validate_cash_session_table_layout_compactness() from public;

commit;
