-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve both trigger signatures, permissions and historical UPDATE protection; the existing AFTER INSERT trigger still persists the complete cost atomically for old and new clients.

-- Never deploy the provisional-cost removal without the final snapshot trigger.
select 1 / case when exists (
  select 1 from pg_trigger
  where tgrelid = 'public.ticket_lines'::regclass
    and tgname = 'zz_set_ticket_line_theoretical_cost_after_components'
    and tgfoid = 'public.snapshot_ticket_line_theoretical_cost()'::regprocedure
    and tgenabled = 'O' and not tgisinternal
) then 1 else 0 end as final_ticket_cost_trigger_required;

create or replace function public.set_ticket_line_theoretical_cost()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    -- Allow the nested final snapshot update; preserve historical values later.
    if pg_trigger_depth() > 1 then return new; end if;
    new.theoretical_cost_known := old.theoretical_cost_known;
    new.theoretical_cost_cents := old.theoretical_cost_cents;
    return new;
  end if;

  -- The AFTER INSERT trigger calculates once, after components are captured.
  -- Never trust a provisional cost supplied by a client, including older PWAs.
  new.theoretical_cost_known := false;
  new.theoretical_cost_cents := null;
  return new;
end;
$$;

create or replace function public.snapshot_ticket_line_theoretical_cost()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_cost jsonb; v_known boolean; v_cents integer;
begin
  v_cost := public.theoretical_ticket_line_cost(new.id);
  v_known := coalesce((v_cost ->> 'known')::boolean, false);
  v_cents := case when v_known then round(coalesce((v_cost ->> 'cost')::numeric, 0) * 100)::integer else null end;

  -- Unknown cost already has these defaults; avoid another write and its triggers.
  update public.ticket_lines line
  set theoretical_cost_known = v_known, theoretical_cost_cents = v_cents
  where line.id = new.id and line.tenant_id = new.tenant_id
    and (line.theoretical_cost_known is distinct from v_known
      or line.theoretical_cost_cents is distinct from v_cents);
  return new;
end;
$$;
