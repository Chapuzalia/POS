begin;

alter table public.dining_areas
  add column if not exists map_elements jsonb not null default '[]'::jsonb;

alter table public.dining_areas drop constraint if exists dining_areas_map_elements_array;
alter table public.dining_areas add constraint dining_areas_map_elements_array
  check (jsonb_typeof(map_elements) = 'array' and jsonb_array_length(map_elements) <= 250);

commit;
