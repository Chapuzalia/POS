-- Datos fiscales opcionales por local para la cabecera del ticket impreso.

begin;

alter table public.venues
  add column if not exists address text,
  add column if not exists legal_name text,
  add column if not exists tax_id text;

alter table public.venues drop constraint if exists venues_ticket_fiscal_details_check;
alter table public.venues add constraint venues_ticket_fiscal_details_check
  check (
    (address is null or char_length(address) <= 300)
    and (legal_name is null or char_length(legal_name) <= 80)
    and (tax_id is null or char_length(tax_id) <= 80)
  );

comment on column public.venues.address is
  'Direccion postal que se imprime en la cabecera del ticket.';
comment on column public.venues.legal_name is
  'Razon social que se imprime como Razon Social en el ticket.';
comment on column public.venues.tax_id is
  'NIF o CIF que se imprime como NIF/CIF en el ticket.';

commit;
