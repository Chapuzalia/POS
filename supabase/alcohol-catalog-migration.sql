-- Migracion para el nuevo modelo de catalogo de bar/discoteca.
-- Ejecutar una vez en Supabase SQL Editor antes de usar el TPV actualizado.

alter table public.categories
drop constraint if exists categories_kind_check;

alter table public.categories
add constraint categories_kind_check
check (kind in ('beer', 'mixed', 'shot', 'other', 'alcohol', 'mixer', 'beer_bottle', 'soft_bottle', 'cocktail'));

alter table public.products
drop constraint if exists products_kind_check;

alter table public.products
add constraint products_kind_check
check (kind in ('beer', 'mixed', 'shot', 'other', 'alcohol', 'mixer', 'beer_bottle', 'soft_bottle', 'cocktail'));

alter table public.products
add column if not exists sale_formats text[] not null default '{}'::text[];

alter table public.products
add column if not exists can_sell_standalone boolean not null default true;

alter table public.products
add column if not exists can_use_as_mixer boolean not null default false;

alter table public.products
drop constraint if exists products_sale_formats_check;

alter table public.products
add constraint products_sale_formats_check
check (sale_formats <@ array['cubata', 'copa', 'shot', 'beer_bottle', 'soft_bottle', 'cocktail']::text[]);

update public.categories
set kind = case
  when kind = 'beer' then 'beer_bottle'
  when kind in ('mixed', 'shot') then 'alcohol'
  when kind = 'other' then 'mixer'
  else kind
end
where kind in ('beer', 'mixed', 'shot', 'other');

update public.products
set kind = case
  when kind = 'beer' then 'beer_bottle'
  when kind in ('mixed', 'shot') then 'alcohol'
  when kind = 'other' then 'soft_bottle'
  else kind
end
where kind in ('beer', 'mixed', 'shot', 'other');

update public.products
set sale_formats = case
  when kind = 'alcohol' then array['cubata', 'copa', 'shot']::text[]
  when kind = 'mixed' then array['cubata']::text[]
  when kind = 'shot' then array['shot']::text[]
  when kind in ('beer', 'beer_bottle') then array['beer_bottle']::text[]
  when kind in ('mixer', 'soft_bottle', 'other') then array['soft_bottle']::text[]
  when kind = 'cocktail' then array['cocktail']::text[]
  else array['soft_bottle']::text[]
end
where sale_formats = '{}'::text[];

update public.products
set can_use_as_mixer = true
where kind = 'mixer';

-- Datos base opcionales para empezar con el flujo Cubata -> familia alcohol -> marca -> mixer.
-- Ajusta el slug si tu tenant no es mess_gold.

do $$
declare
  v_tenant_slug text := 'mess_gold';
  v_tenant_id uuid;
  v_gin_category uuid;
  v_rum_category uuid;
  v_whisky_category uuid;
  v_mixer_category uuid;
  v_beer_category uuid;
  v_cocktail_category uuid;
  v_product_id uuid;
begin
  select id into v_tenant_id from public.tenants where slug = v_tenant_slug limit 1;

  if v_tenant_id is null then
    raise notice 'No existe tenant con slug %, se omiten datos opcionales.', v_tenant_slug;
    return;
  end if;

  if not exists (select 1 from public.categories where tenant_id = v_tenant_id and name = 'Ginebra') then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Ginebra', 'alcohol', 'alcohol', 10);
  end if;
  if not exists (select 1 from public.categories where tenant_id = v_tenant_id and name = 'Ron') then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Ron', 'alcohol', 'alcohol', 20);
  end if;
  if not exists (select 1 from public.categories where tenant_id = v_tenant_id and name = 'Whisky') then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Whisky', 'alcohol', 'alcohol', 30);
  end if;
  if not exists (select 1 from public.categories where tenant_id = v_tenant_id and name = 'Mixers y refrescos') then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Mixers y refrescos', 'mixer', 'mixer', 40);
  end if;
  if not exists (select 1 from public.categories where tenant_id = v_tenant_id and name = 'Cervezas') then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Cervezas', 'beer_bottle', 'beer', 50);
  end if;
  if not exists (select 1 from public.categories where tenant_id = v_tenant_id and name = 'Cocteles') then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Cocteles', 'cocktail', 'martini', 60);
  end if;

  select id into v_gin_category from public.categories where tenant_id = v_tenant_id and name = 'Ginebra' limit 1;
  select id into v_rum_category from public.categories where tenant_id = v_tenant_id and name = 'Ron' limit 1;
  select id into v_whisky_category from public.categories where tenant_id = v_tenant_id and name = 'Whisky' limit 1;
  select id into v_mixer_category from public.categories where tenant_id = v_tenant_id and name = 'Mixers y refrescos' limit 1;
  select id into v_beer_category from public.categories where tenant_id = v_tenant_id and name = 'Cervezas' limit 1;
  select id into v_cocktail_category from public.categories where tenant_id = v_tenant_id and name = 'Cocteles' limit 1;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Seagrams' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_gin_category, 'Seagrams', 'Ginebra', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 10)
    returning id into v_product_id;
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values
      (v_tenant_id, v_product_id, 'Cubata', 900, true, 1),
      (v_tenant_id, v_product_id, 'Copa', 700, false, 2),
      (v_tenant_id, v_product_id, 'Chupito', 350, false, 3);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Tonica' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_mixer_category, 'Tonica', 'Mixer y refresco', 'mixer', array['soft_bottle'], true, true, 10)
    returning id into v_product_id;
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Botellin', 300, true, 1);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Mojito' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_cocktail_category, 'Mojito', 'Coctel preparado', 'cocktail', array['cocktail'], true, false, 10)
    returning id into v_product_id;
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Coctel', 900, true, 1);
  end if;
end $$;
