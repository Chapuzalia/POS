-- Permite configurar suplementos por mixer cuando se usa en cubatas.

alter table public.products
add column if not exists mixer_supplement_cents integer not null default 0 check (mixer_supplement_cents >= 0);
