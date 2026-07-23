begin;

alter table public.venues
  add column if not exists day_change_time time without time zone;

comment on column public.venues.day_change_time is
  'Hora local a la que comienza el nuevo dia operativo para informes y estadisticas. NULL usa el dia natural.';

create index if not exists sales_venue_local_created_idx
  on public.sales (tenant_id, venue_id, local_created_at desc);

create index if not exists tickets_venue_local_created_idx
  on public.tickets (tenant_id, venue_id, local_created_at desc);

commit;
