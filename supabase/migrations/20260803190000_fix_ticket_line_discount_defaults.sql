-- Ticket creation RPCs predate the per-line discount columns and omit them.
-- Populate valid gross defaults before NOT NULL/check constraints run; the
-- statement-level allocation trigger can then distribute any ticket discount.

create or replace function public.set_ticket_line_discount_defaults()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.discount_amount_cents := coalesce(new.discount_amount_cents, 0);
  new.net_total_cents := coalesce(
    new.net_total_cents,
    new.line_total_cents - new.discount_amount_cents
  );
  return new;
end;
$$;

drop trigger if exists set_ticket_line_discount_defaults_trigger
  on public.ticket_lines;
create trigger set_ticket_line_discount_defaults_trigger
before insert on public.ticket_lines
for each row execute function public.set_ticket_line_discount_defaults();

revoke all on function public.set_ticket_line_discount_defaults() from public;
