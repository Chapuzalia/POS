-- Formatos de venta configurables por tenant.

create table if not exists public.sale_formats (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  key text not null,
  label text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key),
  constraint sale_formats_key_check check (key ~ '^[a-z0-9_]+$' and key not in ('all', 'top'))
);

alter table public.products
drop constraint if exists products_sale_formats_check;

alter table public.sale_formats
drop constraint if exists sale_formats_key_check;

alter table public.sale_formats
add constraint sale_formats_key_check
check (key ~ '^[a-z0-9_]+$' and key not in ('all', 'top'));

create index if not exists sale_formats_tenant_idx on public.sale_formats (tenant_id, sort_order);

alter table public.sale_formats enable row level security;

drop policy if exists "sale_formats_tenant_access" on public.sale_formats;
create policy "sale_formats_tenant_access"
on public.sale_formats for all
using (public.user_has_tenant_access(tenant_id))
with check (public.user_has_tenant_access(tenant_id));

drop trigger if exists set_sale_formats_updated_at on public.sale_formats;
create trigger set_sale_formats_updated_at
before update on public.sale_formats
for each row execute function public.set_updated_at();

insert into public.sale_formats (tenant_id, key, label, sort_order, is_active)
select tenant_id, key, label, sort_order, true
from (
  select distinct tenant_id from public.products
  union
  select id as tenant_id from public.tenants
) tenants_with_catalog
cross join (
  values
    ('cubata', 'Cubata', 1),
    ('copa', 'Copa', 2),
    ('shot', 'Chupito', 3),
    ('beer_bottle', 'Botellin cerveza', 4),
    ('soft_bottle', 'Botellin refresco', 5),
    ('cocktail', 'Coctel', 6)
) as defaults(key, label, sort_order)
on conflict (tenant_id, key) do nothing;
