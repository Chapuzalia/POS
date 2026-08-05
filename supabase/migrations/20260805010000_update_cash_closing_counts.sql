create table if not exists public.cash_closing_count_edits (
  id bigint generated always as identity primary key,
  cash_closing_id uuid not null references public.cash_sessions(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  previous_counted_cash_cents integer not null,
  previous_counted_card_cents integer not null,
  counted_cash_cents integer not null,
  counted_card_cents integer not null,
  created_at timestamptz not null default now(),
  constraint cash_closing_count_edits_values_check check (
    previous_counted_cash_cents >= 0
    and previous_counted_card_cents >= 0
    and counted_cash_cents >= 0
    and counted_card_cents >= 0
  )
);

create index if not exists cash_closing_count_edits_closing_idx
  on public.cash_closing_count_edits(cash_closing_id, created_at desc);

alter table public.cash_closing_count_edits enable row level security;

drop policy if exists cash_closing_count_edits_select on public.cash_closing_count_edits;
create policy cash_closing_count_edits_select
on public.cash_closing_count_edits
for select
to authenticated
using (
  public.user_has_tenant_role(tenant_id, array['owner'::text])
  or (
    public.user_has_tenant_role(tenant_id, array['manager'::text])
    and exists (
      select 1
      from public.manager_venue_assignments assignment
      where assignment.tenant_id = cash_closing_count_edits.tenant_id
        and assignment.manager_user_id = (select auth.uid())
        and assignment.venue_id = cash_closing_count_edits.venue_id
    )
  )
);

revoke all on table public.cash_closing_count_edits from public, anon, authenticated;
grant select on table public.cash_closing_count_edits to authenticated;
grant all on table public.cash_closing_count_edits to service_role;

create or replace function public.update_cash_closing_counts(
  p_cash_closing_id uuid,
  p_counted_cash_cents integer,
  p_counted_card_cents integer
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  closing_row public.cash_sessions%rowtype;
  membership_role text;
  cash_difference integer;
  card_difference integer;
  updated_snapshot jsonb;
begin
  if auth.uid() is null and auth.role() <> 'service_role' then
    raise exception 'Autenticacion requerida' using errcode = '42501';
  end if;
  if p_counted_cash_cents is null or p_counted_cash_cents < 0
    or p_counted_card_cents is null or p_counted_card_cents < 0 then
    raise exception 'Los conteos finales no son validos' using errcode = '22023';
  end if;

  select session.*
  into closing_row
  from public.cash_sessions session
  where session.id = p_cash_closing_id
  for update;

  if closing_row.id is null
    or closing_row.status <> 'closed'
    or closing_row.print_snapshot is null
    or closing_row.expected_cash_cents is null
    or closing_row.expected_card_cents is null then
    raise exception 'Cierre no disponible' using errcode = '22023';
  end if;

  if auth.role() <> 'service_role' then
    select membership.role
    into membership_role
    from public.tenant_memberships membership
    where membership.tenant_id = closing_row.tenant_id
      and membership.user_id = auth.uid()
      and membership.is_active = true;

    if membership_role = 'manager' and not exists (
      select 1
      from public.manager_venue_assignments assignment
      where assignment.tenant_id = closing_row.tenant_id
        and assignment.manager_user_id = auth.uid()
        and assignment.venue_id = closing_row.venue_id
    ) then
      raise exception 'No tienes acceso a este local' using errcode = '42501';
    end if;
    if membership_role is null or membership_role not in ('owner', 'manager') then
      raise exception 'No tienes permiso para editar cierres' using errcode = '42501';
    end if;
  end if;

  if closing_row.counted_cash_cents = p_counted_cash_cents
    and closing_row.counted_card_cents = p_counted_card_cents then
    return true;
  end if;

  cash_difference := p_counted_cash_cents - closing_row.expected_cash_cents;
  card_difference := p_counted_card_cents - closing_row.expected_card_cents;
  updated_snapshot := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          closing_row.print_snapshot,
          '{expectedAndCounted,countedCashCents}',
          to_jsonb(p_counted_cash_cents),
          false
        ),
        '{expectedAndCounted,countedCardCents}',
        to_jsonb(p_counted_card_cents),
        false
      ),
      '{differences,cashDifferenceCents}',
      to_jsonb(cash_difference),
      false
    ),
    '{differences,cardDifferenceCents}',
    to_jsonb(card_difference),
    false
  );

  insert into public.cash_closing_count_edits (
    cash_closing_id,
    tenant_id,
    venue_id,
    actor_id,
    previous_counted_cash_cents,
    previous_counted_card_cents,
    counted_cash_cents,
    counted_card_cents
  ) values (
    closing_row.id,
    closing_row.tenant_id,
    closing_row.venue_id,
    auth.uid(),
    coalesce(closing_row.counted_cash_cents, 0),
    coalesce(closing_row.counted_card_cents, 0),
    p_counted_cash_cents,
    p_counted_card_cents
  );

  update public.cash_sessions
  set counted_cash_cents = p_counted_cash_cents,
      counted_card_cents = p_counted_card_cents,
      discrepancy_cents = cash_difference
        + card_difference
        + coalesce(counted_invitation_cents, 0)
        - coalesce(expected_invitation_cents, 0)
        + coalesce(counted_other_cents, 0)
        - coalesce(expected_other_cents, 0),
      print_snapshot = updated_snapshot
  where id = closing_row.id;

  return true;
end;
$$;

revoke all on function public.update_cash_closing_counts(uuid, integer, integer)
  from public, anon;
grant execute on function public.update_cash_closing_counts(uuid, integer, integer)
  to authenticated, service_role;
