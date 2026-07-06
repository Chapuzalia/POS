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
  v_category_mixed uuid;
  v_category_shot uuid;
  v_category_other uuid;
  v_product_id uuid;
  v_group_id uuid;
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

  select id into v_category_beer from public.categories where tenant_id = v_tenant_id and name = 'Cerveza' limit 1;
  if v_category_beer is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Cerveza', 'beer', 'beer', 1)
    returning id into v_category_beer;
  end if;

  select id into v_category_mixed from public.categories where tenant_id = v_tenant_id and name = 'Copas' limit 1;
  if v_category_mixed is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Copas', 'mixed', 'martini', 2)
    returning id into v_category_mixed;
  end if;

  select id into v_category_shot from public.categories where tenant_id = v_tenant_id and name = 'Chupitos' limit 1;
  if v_category_shot is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Chupitos', 'shot', 'shot', 3)
    returning id into v_category_shot;
  end if;

  select id into v_category_other from public.categories where tenant_id = v_tenant_id and name = 'Sin alcohol' limit 1;
  if v_category_other is null then
    insert into public.categories (tenant_id, name, kind, icon, sort_order)
    values (v_tenant_id, 'Sin alcohol', 'other', 'glass', 4)
    returning id into v_category_other;
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Cana' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sort_order)
    values (v_tenant_id, v_category_beer, 'Cana', 'Cerveza de barril', 'beer', 1)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Vaso') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Vaso', 300, true, 1);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Gin Tonic' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sort_order)
    values (v_tenant_id, v_category_mixed, 'Gin Tonic', 'Copa configurable', 'mixed', 1)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Normal') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Normal', 800, true, 1);
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Premium') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Premium', 1100, false, 2);
  end if;

  select id into v_group_id from public.modifier_groups where product_id = v_product_id and name = 'Tonica' limit 1;
  if v_group_id is null then
    insert into public.modifier_groups (tenant_id, product_id, name, min_select, max_select, sort_order)
    values (v_tenant_id, v_product_id, 'Tonica', 1, 1, 1)
    returning id into v_group_id;
  end if;
  if not exists (select 1 from public.modifiers where group_id = v_group_id and name = 'Schweppes') then
    insert into public.modifiers (tenant_id, group_id, name, price_cents, sort_order)
    values (v_tenant_id, v_group_id, 'Schweppes', 0, 1);
  end if;
  if not exists (select 1 from public.modifiers where group_id = v_group_id and name = 'Fever-Tree') then
    insert into public.modifiers (tenant_id, group_id, name, price_cents, sort_order)
    values (v_tenant_id, v_group_id, 'Fever-Tree', 150, 2);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Tequila' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sort_order)
    values (v_tenant_id, v_category_shot, 'Tequila', 'Chupito clasico', 'shot', 1)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Chupito') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Chupito', 350, true, 1);
  end if;

  select id into v_product_id from public.products where tenant_id = v_tenant_id and name = 'Agua' limit 1;
  if v_product_id is null then
    insert into public.products (tenant_id, category_id, name, description, kind, sort_order)
    values (v_tenant_id, v_category_other, 'Agua', 'Botella fria', 'other', 1)
    returning id into v_product_id;
  end if;
  if not exists (select 1 from public.product_variants where product_id = v_product_id and name = 'Botella') then
    insert into public.product_variants (tenant_id, product_id, name, price_cents, is_default, sort_order)
    values (v_tenant_id, v_product_id, 'Botella', 250, true, 1);
  end if;

  raise notice 'Tenant % listo para el usuario %', v_tenant_slug, v_user_email;
end $$;
