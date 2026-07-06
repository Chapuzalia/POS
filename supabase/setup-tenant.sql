-- Bootstrap de un negocio real para poder iniciar sesion en el TPV.
-- Ejecutar en Supabase SQL Editor despues de crear el usuario en Authentication.
-- Ajusta estos valores si cambian el slug, email o nombre del local.

do $$
declare
  v_tenant_name text := 'Mess Gold';
  v_tenant_slug text := 'mess_gold';
  v_user_email text := 'admin@messigualada.com';
  v_venue_name text := 'Sala principal';

  v_tenant_id uuid;
  v_user_id uuid;
  v_venue_id uuid;
  v_category_beer uuid;
  v_category_cocktail uuid;
  v_category_gin uuid;
  v_category_mixer uuid;
  v_category_rum uuid;
  v_category_whisky uuid;
  v_product_id uuid;
begin
  select id
  into v_user_id
  from auth.users
  where lower(email) = lower(v_user_email)
  limit 1;

  if v_user_id is null then
    raise exception 'No existe un usuario en Supabase Auth con email %', v_user_email;
  end if;

  insert into public.tenants (name, slug)
  values (v_tenant_name, v_tenant_slug)
  on conflict (slug) do update
  set name = excluded.name
  returning id into v_tenant_id;

  insert into public.tenant_memberships (tenant_id, user_id, role, is_active)
  values (v_tenant_id, v_user_id, 'owner', true)
  on conflict (tenant_id, user_id) do update
  set role = excluded.role,
      is_active = true;

  select id
  into v_venue_id
  from public.venues
  where tenant_id = v_tenant_id
    and name = v_venue_name
  limit 1;

  if v_venue_id is null then
    insert into public.venues (tenant_id, name, sort_order, is_active)
    values (v_tenant_id, v_venue_name, 1, true)
    returning id into v_venue_id;
  else
    update public.venues
    set is_active = true,
        sort_order = 1
    where id = v_venue_id;
  end if;

  select id into v_category_gin from public.categories where tenant_id = v_tenant_id and name = 'Ginebra' limit 1;
  if v_category_gin is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Ginebra', 'alcohol', 'alcohol', 10)
    returning id into v_category_gin;
  end if;

  select id into v_category_rum from public.categories where tenant_id = v_tenant_id and name = 'Ron' limit 1;
  if v_category_rum is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Ron', 'alcohol', 'alcohol', 20)
    returning id into v_category_rum;
  end if;

  select id into v_category_whisky from public.categories where tenant_id = v_tenant_id and name = 'Whisky' limit 1;
  if v_category_whisky is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Whisky', 'alcohol', 'alcohol', 30)
    returning id into v_category_whisky;
  end if;

  select id into v_category_mixer from public.categories where tenant_id = v_tenant_id and name = 'Mixers y refrescos' limit 1;
  if v_category_mixer is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Mixers y refrescos', 'mixer', 'glass', 40)
    returning id into v_category_mixer;
  end if;

  select id into v_category_beer from public.categories where tenant_id = v_tenant_id and name = 'Cervezas' limit 1;
  if v_category_beer is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Cervezas', 'beer_bottle', 'beer', 50)
    returning id into v_category_beer;
  end if;

  select id into v_category_cocktail from public.categories where tenant_id = v_tenant_id and name = 'Cocteles' limit 1;
  if v_category_cocktail is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Cocteles', 'cocktail', 'martini', 60)
    returning id into v_category_cocktail;
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Seagrams' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_category_gin, 'Seagrams', 'Ginebra', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 1)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Cubata') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Cubata', 900, true, 1);
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Copa') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Copa', 700, false, 2);
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Chupito') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Chupito', 350, false, 3);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Barcelo' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_category_rum, 'Barcelo', 'Ron', 'alcohol', array['cubata', 'copa', 'shot'], true, false, 2)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Cubata') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Cubata', 850, true, 1);
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Copa') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Copa', 650, false, 2);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Tonica' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_category_mixer, 'Tonica', 'Botellin y mixer', 'mixer', array['soft_bottle'], true, true, 1)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Botellin') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Botellin', 300, true, 1);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Coca-Cola' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_category_mixer, 'Coca-Cola', 'Botellin y mixer', 'mixer', array['soft_bottle'], true, true, 2)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Botellin') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Botellin', 300, true, 1);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Estrella Damm' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_category_beer, 'Estrella Damm', 'Botellin de cerveza', 'beer_bottle', array['beer_bottle'], true, false, 1)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Botellin') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Botellin', 350, true, 1);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Mojito' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sale_formats, can_sell_standalone, can_use_as_mixer, sort_order)
    values (v_tenant_id, v_category_cocktail, 'Mojito', 'Coctel preparado', 'cocktail', array['cocktail'], true, false, 1)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Coctel') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Coctel', 900, true, 1);
  end if;

  raise notice 'Tenant % listo para el usuario %', v_tenant_slug, v_user_email;
end $$;
