-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: Restricts only newly created connector routines; browser management RPCs retain authenticated execute and server RPCs grant only service_role.

-- Private storage: no Data API grants or policies for browser roles.
create schema if not exists tickit_private;
create table tickit_private.integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  venue_id uuid not null unique references public.venues(id),
  key_hash text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table tickit_private.table_links (
  table_id uuid primary key references public.restaurant_tables(id),
  integration_id uuid not null references tickit_private.integrations(id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$')
);
create index tickit_table_links_integration_idx on tickit_private.table_links(integration_id);
create table tickit_private.sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  integration_id uuid not null references tickit_private.integrations(id),
  table_id uuid not null references public.restaurant_tables(id),
  order_id uuid not null references public.orders(id),
  occupation_id uuid not null,
  expires_at timestamptz not null
);
create index tickit_sessions_integration_idx on tickit_private.sessions(integration_id);
create index tickit_sessions_table_idx on tickit_private.sessions(table_id);
create index tickit_sessions_order_idx on tickit_private.sessions(order_id);
create table tickit_private.requests (
  integration_id uuid not null references tickit_private.integrations(id),
  request_id uuid not null,
  token_hash text not null,
  lines jsonb not null,
  receipt jsonb not null,
  primary key (integration_id, request_id)
);
alter table tickit_private.integrations enable row level security;
alter table tickit_private.table_links enable row level security;
alter table tickit_private.sessions enable row level security;
alter table tickit_private.requests enable row level security;

create function public.tickit_carta_configure(p_venue_id uuid, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare tenant uuid; secret text; integration uuid;
begin
  select tenant_id into tenant from public.venues where id=p_venue_id;
  if auth.uid() is null or tenant is null or not exists (
    select 1 from public.tenant_memberships where tenant_id=tenant and user_id=auth.uid() and role='owner' and is_active
  ) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  if not p_enabled then
    update tickit_private.integrations set enabled=false where venue_id=p_venue_id;
    delete from tickit_private.sessions where integration_id in (select id from tickit_private.integrations where venue_id=p_venue_id);
    return jsonb_build_object('enabled',false);
  end if;
  secret := 'tk_' || replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into tickit_private.integrations(tenant_id,venue_id,key_hash)
    values(tenant,p_venue_id,encode(extensions.digest(secret,'sha256'),'hex'))
    on conflict(venue_id) do update set key_hash=excluded.key_hash, enabled=true returning id into integration;
  delete from tickit_private.sessions where integration_id=integration;
  return jsonb_build_object('enabled',true,'apiKey',secret,'integrationId',integration);
end $$;
revoke all on function public.tickit_carta_configure(uuid,boolean) from public, anon;
grant execute on function public.tickit_carta_configure(uuid,boolean) to authenticated;

create function public.tickit_carta_table_link(p_table_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.restaurant_tables%rowtype; integration uuid; token text;
begin
  select * into t from public.restaurant_tables where id=p_table_id;
  if auth.uid() is null or t.id is null or not exists (
    select 1 from public.tenant_memberships where tenant_id=t.tenant_id and user_id=auth.uid() and role='owner' and is_active
  ) then
    raise exception 'FORBIDDEN' using errcode='42501';
  end if;
  select id into integration from tickit_private.integrations where venue_id=t.venue_id and tenant_id=t.tenant_id and enabled;
  if integration is null or not t.is_active or t.cash_session_id is not null then raise exception 'INTEGRATION_UNAVAILABLE'; end if;
  token:=replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into tickit_private.table_links(table_id,integration_id,token_hash)
    values(t.id,integration,encode(extensions.digest(token,'sha256'),'hex'))
    on conflict(table_id) do update set token_hash=excluded.token_hash,integration_id=excluded.integration_id;
  -- Rotating a table support also invalidates all previously issued sessions.
  delete from tickit_private.sessions where table_id=t.id;
  return jsonb_build_object('tableToken',token,'tableName',t.name);
end $$;
revoke all on function public.tickit_carta_table_link(uuid) from public, anon;
grant execute on function public.tickit_carta_table_link(uuid) to authenticated;

create function public.tickit_api_auth(p_key_hash text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',id) from tickit_private.integrations where key_hash=p_key_hash and enabled;
$$;
revoke all on function public.tickit_api_auth(text) from public, anon, authenticated;
grant execute on function public.tickit_api_auth(text) to service_role;

create function tickit_private.require_integration(p_id uuid) returns tickit_private.integrations
language plpgsql stable set search_path = '' as $$
declare i tickit_private.integrations;
begin
  select * into i from tickit_private.integrations where id=p_id and enabled;
  if i.id is null then raise exception 'INTEGRATION_UNAVAILABLE' using errcode='42501'; end if;
  return i;
end $$;
revoke all on function tickit_private.require_integration(uuid) from public, anon;

create function public.tickit_api_capabilities(p_integration_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i tickit_private.integrations;
begin
  i:=tickit_private.require_integration(p_integration_id);
  return jsonb_build_object('apiVersion','1','venueId',i.venue_id,'catalog',true,'orders',true,'production','saved','nfcProof',false);
end $$;
revoke all on function public.tickit_api_capabilities(uuid) from public, anon, authenticated;
grant execute on function public.tickit_api_capabilities(uuid) to service_role;

create function public.tickit_api_catalog(p_integration_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare i tickit_private.integrations; catalog jsonb;
begin
  i:=tickit_private.require_integration(p_integration_id);
  catalog:=public.get_catalog(i.venue_id,'pos');
  return catalog || jsonb_build_object('apiVersion','1',
    'zones',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'sort_order',sort_order)) from public.dining_areas where tenant_id=i.tenant_id and venue_id=i.venue_id and is_active),'[]'::jsonb),
    'tables',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'area_id',area_id,'capacity',capacity,'sort_order',sort_order)) from public.restaurant_tables where tenant_id=i.tenant_id and venue_id=i.venue_id and is_active and cash_session_id is null),'[]'::jsonb));
end $$;
revoke all on function public.tickit_api_catalog(uuid) from public, anon, authenticated;
grant execute on function public.tickit_api_catalog(uuid) to service_role;

create function public.tickit_api_session(p_integration_id uuid,p_table_hash text,p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i tickit_private.integrations; t uuid; o public.orders%rowtype; expiry timestamptz;
begin
  select * into i from tickit_private.integrations where id=p_integration_id and enabled for share;
  if i.id is null then raise exception 'INTEGRATION_UNAVAILABLE' using errcode='42501'; end if;
  select l.table_id into t from tickit_private.table_links l join public.restaurant_tables rt on rt.id=l.table_id
    where l.integration_id=i.id and l.token_hash=p_table_hash and rt.is_active and rt.venue_id=i.venue_id and rt.tenant_id=i.tenant_id for share of l;
  if t is null then raise exception 'SESSION_UNAVAILABLE'; end if;
  select orders.* into o from public.orders orders
    join public.order_tables ot on ot.order_group_id=orders.order_group_id and ot.table_id=t and ot.released_at is null
    join public.cash_sessions cs on cs.id=orders.cash_session_id and cs.status='open'
    where orders.tenant_id=i.tenant_id and orders.venue_id=i.venue_id and orders.status='open'
    order by orders.split_sequence,orders.id limit 1 for update of orders;
  if o.id is null then raise exception 'SESSION_UNAVAILABLE'; end if;
  expiry:=now()+interval '2 hours';
  insert into tickit_private.sessions values(p_token_hash,i.id,t,o.id,o.order_group_id,expiry);
  return jsonb_build_object('occupationId',o.order_group_id,'expiresAt',expiry);
end $$;
revoke all on function public.tickit_api_session(uuid,text,text) from public, anon, authenticated;
grant execute on function public.tickit_api_session(uuid,text,text) to service_role;

-- Canonical line resolver and atomic append follow below.
-- Uses the POS canonical modifier and selection rules; never trusts client money or snapshots.
create function tickit_private.resolve_line(v_venue_id uuid,v_line jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_product_id uuid; v_variant_id uuid; v_base_price integer; v_unit_price integer;
  v_sent_count integer; v_component_count integer; v_line_modifiers jsonb;
  v_submitted_modifiers jsonb; v_components jsonb;
begin
    v_product_id := (v_line ->> 'productId')::uuid;
    v_variant_id := (v_line ->> 'variantId')::uuid;
    select v.price_cents into v_base_price
    from public.product_variants v
    join public.products p on p.id = v.product_id and p.venue_id = v_venue_id and p.is_active
    where v.id = v_variant_id and v.product_id = v_product_id and v.venue_id = v_venue_id and v.is_active;
    if v_base_price is null then raise exception 'CATALOG_PRODUCT_NOT_SELLABLE'; end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', value)), '[]'::jsonb)
      into v_submitted_modifiers
      from jsonb_array_elements_text(coalesce(v_line -> 'modifierIds', '[]'::jsonb));
    v_line_modifiers := public.canonical_catalog_modifiers(
      v_venue_id, v_product_id, v_variant_id, v_submitted_modifiers
    );
    if jsonb_array_length(v_line_modifiers) <> jsonb_array_length(v_submitted_modifiers) then
      raise exception 'CATALOG_INVALID_MODIFIER';
    end if;
    if exists (
      select 1
      from public.product_modifier_group_assignments a
      join public.modifier_groups g on g.id = a.group_id and g.is_active
      left join lateral (
        select count(*)::integer amount from jsonb_array_elements(v_line_modifiers) m
        where m ->> 'groupId' = g.id::text
      ) chosen on true
      where a.product_id = v_product_id and a.venue_id = v_venue_id and a.is_active
        and (a.applies_to_all_variants or exists (
          select 1 from public.product_modifier_group_assignment_variants av
          where av.assignment_id = a.id and av.variant_id = v_variant_id
        ))
        and (chosen.amount < a.min_selection or chosen.amount > a.max_selection)
    ) then raise exception 'CATALOG_MODIFIER_LIMITS'; end if;

    v_sent_count := jsonb_array_length(coalesce(v_line -> 'components', '[]'::jsonb));
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id,
      'type', g.kind,
      'selectionGroupId', g.id,
      'selectionGroupName', coalesce(a.display_name, g.name),
      'productId', p.id,
      'variantId', selected_variant.id,
      'productName', p.name,
      'variantName', selected_variant.name,
      'quantity', submitted.quantity,
      'priceDeltaCents', o.supplement_cents,
      'sortOrder', o.sort_order,
      'modifiers', public.canonical_catalog_modifiers(
        v_venue_id, p.id, selected_variant.id, submitted.modifiers
      )
    ) order by a.sort_order, g.sort_order, o.sort_order, o.id), '[]'::jsonb), count(*)::integer
    into v_components, v_component_count
    from jsonb_to_recordset(coalesce(v_line -> 'components', '[]'::jsonb)) submitted(
      id text, "selectionGroupId" text, "productId" text, "variantId" text,
      quantity integer, modifiers jsonb
    )
    join public.product_selection_group_assignments a on a.product_id = v_product_id
      and a.venue_id = v_venue_id and a.is_active
      and (a.applies_to_all_variants or exists (
        select 1 from public.product_selection_group_assignment_variants av
        where av.assignment_id = a.id and av.variant_id = v_variant_id
      ))
    join public.selection_groups g on g.id = a.group_id and g.venue_id = v_venue_id and g.is_active
      and (submitted."selectionGroupId" is null or g.id = nullif(submitted."selectionGroupId", '')::uuid)
    join public.selection_group_options o on o.id = nullif(submitted.id, '')::uuid
      and o.group_id = g.id and o.venue_id = v_venue_id and o.is_active
      and o.product_id = nullif(submitted."productId", '')::uuid
    join public.products p on p.id = o.product_id and p.venue_id = v_venue_id and p.is_active
    join lateral (
      select candidate.id, candidate.name
      from public.product_variants candidate
      where candidate.product_id = p.id and candidate.venue_id = v_venue_id and candidate.is_active
        and (o.variant_id is null and candidate.is_default or candidate.id = o.variant_id)
      order by (candidate.id = o.variant_id) desc, candidate.is_default desc, candidate.sort_order, candidate.id
      limit 1
    ) selected_variant on true
    where submitted.quantity > 0
      and (o.max_quantity is null or submitted.quantity <= o.max_quantity)
      and (submitted."variantId" is null or selected_variant.id = nullif(submitted."variantId", '')::uuid);

    if v_component_count <> v_sent_count then raise exception 'CATALOG_INVALID_SELECTION_OPTION'; end if;
    if exists (
      select 1
      from public.product_selection_group_assignments a
      join public.selection_groups g on g.id = a.group_id and g.is_active
      left join lateral (
        select coalesce(sum((component ->> 'quantity')::integer), 0)::integer amount
        from jsonb_array_elements(v_components) component
        where component ->> 'selectionGroupId' = g.id::text
      ) chosen on true
      where a.product_id = v_product_id and a.venue_id = v_venue_id and a.is_active
        and (a.applies_to_all_variants or exists (
          select 1 from public.product_selection_group_assignment_variants av
          where av.assignment_id = a.id and av.variant_id = v_variant_id
        ))
        and (chosen.amount < a.min_selection or chosen.amount > a.max_selection)
    ) then raise exception 'CATALOG_SELECTION_LIMITS'; end if;

    if exists (
      select 1
      from jsonb_array_elements(v_components) canonical
      join lateral (
        select submitted.modifiers
        from jsonb_to_recordset(coalesce(v_line -> 'components', '[]'::jsonb)) submitted(id text, modifiers jsonb)
        where submitted.id = canonical ->> 'id' limit 1
      ) source on true
      where jsonb_array_length(coalesce(canonical -> 'modifiers', '[]'::jsonb))
        <> jsonb_array_length(coalesce(source.modifiers, '[]'::jsonb))
    ) then raise exception 'CATALOG_INVALID_COMPONENT_MODIFIER'; end if;

    if exists (
      select 1
      from jsonb_array_elements(v_components) component
      join public.product_modifier_group_assignments a
        on a.product_id = (component ->> 'productId')::uuid
        and a.venue_id = v_venue_id and a.is_active
        and (a.applies_to_all_variants or exists (
          select 1 from public.product_modifier_group_assignment_variants av
          where av.assignment_id = a.id and av.variant_id = (component ->> 'variantId')::uuid
        ))
      join public.modifier_groups g on g.id = a.group_id and g.is_active
      left join lateral (
        select count(*)::integer amount
        from jsonb_array_elements(coalesce(component -> 'modifiers', '[]'::jsonb)) selected
        where selected ->> 'groupId' = g.id::text
      ) chosen on true
      where chosen.amount < a.min_selection or chosen.amount > a.max_selection
    ) then raise exception 'CATALOG_COMPONENT_MODIFIER_LIMITS'; end if;

    v_unit_price := v_base_price
      + coalesce((select sum((m ->> 'priceCents')::integer) from jsonb_array_elements(v_line_modifiers) m), 0)
      + coalesce((select sum((c ->> 'priceDeltaCents')::integer * (c ->> 'quantity')::integer) from jsonb_array_elements(v_components) c), 0)
      + coalesce((select sum((m ->> 'priceCents')::integer * (c ->> 'quantity')::integer)
        from jsonb_array_elements(v_components) c
        cross join lateral jsonb_array_elements(coalesce(c -> 'modifiers', '[]'::jsonb)) m), 0);
    if v_unit_price < 0 then raise exception 'CATALOG_NEGATIVE_FINAL_PRICE'; end if;


  return jsonb_build_object('unitPriceCents',v_unit_price,'basePriceCents',v_base_price,'modifiers',v_line_modifiers,'components',v_components);
end $$;
revoke all on function tickit_private.resolve_line(uuid,jsonb) from public, anon;

create function public.tickit_api_submit(p_integration_id uuid,p_token_hash text,p_request_id uuid,p_lines jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i tickit_private.integrations; s tickit_private.sessions; o public.orders%rowtype;
  previous tickit_private.requests; item jsonb; resolved jsonb; selection jsonb;
  p public.products%rowtype; v public.product_variants%rowtype;
  placement public.catalog_placements%rowtype; snapshot jsonb; line_id uuid; receipt jsonb;
  total bigint:=0; quantity_milli integer; line_ids jsonb:='[]';
begin
  select * into i from tickit_private.integrations where id=p_integration_id and enabled for share;
  if i.id is null then raise exception 'INTEGRATION_UNAVAILABLE' using errcode='42501'; end if;
  if p_request_id is null or p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines) not between 1 and 50 then
    raise exception 'INVALID_REQUEST' using errcode='22023';
  end if;
  -- Serialize the retry key across sessions/processes before reading the receipt.
  perform pg_advisory_xact_lock(hashtextextended(i.id::text || p_request_id::text,0));
  select * into previous from tickit_private.requests where integration_id=i.id and request_id=p_request_id;
  if previous.request_id is not null then
    if previous.token_hash<>p_token_hash or previous.lines<>p_lines then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return previous.receipt;
  end if;
  select * into s from tickit_private.sessions where token_hash=p_token_hash and integration_id=i.id and expires_at>now() for share;
  if s.order_id is null then raise exception 'SESSION_UNAVAILABLE'; end if;
  select * into o from public.orders where id=s.order_id and tenant_id=i.tenant_id and venue_id=i.venue_id for update;
  if o.id is null or o.status<>'open' or o.order_group_id<>s.occupation_id
    or not exists(select 1 from public.cash_sessions where id=o.cash_session_id and status='open')
    or not exists(select 1 from public.restaurant_tables where id=s.table_id and tenant_id=i.tenant_id and venue_id=i.venue_id and is_active)
    or not exists(select 1 from public.order_tables where order_group_id=s.occupation_id and table_id=s.table_id and released_at is null)
    or exists(select 1 from public.restaurant_order_equal_splits where order_group_id=s.occupation_id and status='open') then
    raise exception 'SESSION_UNAVAILABLE';
  end if;
  if (select count(*) from public.order_lines where order_id=o.id)+jsonb_array_length(p_lines)>500 then
    raise exception 'ORDER_TOO_LARGE' using errcode='22023';
  end if;
  for item in select value from jsonb_array_elements(p_lines) loop
    if (item->>'quantityMilli') !~ '^[0-9]+$' then raise exception 'INVALID_QUANTITY' using errcode='22023'; end if;
    quantity_milli:=(item->>'quantityMilli')::integer;
    if quantity_milli not between 1 and 9999000 or length(coalesce(item->>'note',''))>500 then raise exception 'INVALID_LINE' using errcode='22023'; end if;
    select * into p from public.products where id=(item->>'productId')::uuid and tenant_id=i.tenant_id and venue_id=i.venue_id and is_active;
    select * into v from public.product_variants where id=(item->>'variantId')::uuid and product_id=p.id and tenant_id=i.tenant_id and venue_id=i.venue_id and is_active;
    select cp.* into placement from public.catalog_placements cp
      join public.catalog_tabs tab on tab.id=cp.tab_id and tab.is_active
      left join public.categories cat on cat.id=cp.category_id
      where cp.product_id=p.id and cp.venue_id=i.venue_id and cp.tenant_id=i.tenant_id and cp.is_active
        and (cp.variant_id is null or cp.variant_id=v.id) and (cp.category_id is null or cat.is_active)
      order by cp.sort_order,cp.id limit 1;
    if p.id is null or v.id is null or placement.id is null then raise exception 'CATALOG_PRODUCT_NOT_SELLABLE'; end if;
    if v.catalog_sale_format_id is not null and not exists(select 1 from public.catalog_sale_formats where id=v.catalog_sale_format_id and venue_id=i.venue_id and is_active) then raise exception 'CATALOG_PRODUCT_NOT_SELLABLE'; end if;
    if (select count(*) from jsonb_array_elements_text(item->'modifierOptionIds')) <>
      (select count(distinct value) from jsonb_array_elements_text(item->'modifierOptionIds'))
      or (select count(*) from jsonb_array_elements(coalesce(item->'components','[]'))) <>
      (select count(distinct value->>'id') from jsonb_array_elements(coalesce(item->'components','[]'))) then
      raise exception 'CATALOG_DUPLICATE_SELECTION';
    end if;
    selection:=item || jsonb_build_object('modifierIds',item->'modifierOptionIds');
    resolved:=tickit_private.resolve_line(i.venue_id,selection);
    snapshot:=jsonb_build_object('placementId',placement.id,'productType',p.product_type,'productId',p.id,'productName',p.name,
      'variantId',v.id,'variantName',v.name,'basePriceCents',v.price_cents,'vatRate',public.resolve_effective_tax_rate(p.id,i.tenant_id,i.venue_id),
      'categoryId',placement.category_id,'categoryName',(select name from public.categories where id=placement.category_id),
      'catalogTabId',placement.tab_id,'catalogTabName',(select label from public.catalog_tabs where id=placement.tab_id),
      'saleFormatId',v.catalog_sale_format_id,'saleFormatName',coalesce((select name from public.catalog_sale_formats where id=v.catalog_sale_format_id),v.name));
    line_id:=gen_random_uuid();
    insert into public.order_lines(id,tenant_id,venue_id,order_id,product_id,variant_id,product_name,variant_name,unit_price_cents,quantity,modifiers,components,catalog_snapshot,note)
      values(line_id,i.tenant_id,i.venue_id,o.id,p.id,v.id,p.name,v.name,(resolved->>'unitPriceCents')::integer,quantity_milli::numeric/1000,resolved->'modifiers',resolved->'components',snapshot,nullif(trim(item->>'note'),''));
    insert into public.order_line_components(tenant_id,venue_id,order_line_id,component_type,selection_group_id,product_id,variant_id,product_name_snapshot,variant_name_snapshot,quantity,price_delta_cents,sort_order,metadata)
      select i.tenant_id,i.venue_id,line_id,c.type,nullif(c."selectionGroupId",'')::uuid,nullif(c."productId",'')::uuid,nullif(c."variantId",'')::uuid,
        c."productName",c."variantName",c.quantity,c."priceDeltaCents",c."sortOrder",jsonb_build_object('modifiers',coalesce(c.modifiers,'[]'))
      from jsonb_to_recordset(resolved->'components') c(type text,"selectionGroupId" text,"productId" text,"variantId" text,"productName" text,"variantName" text,quantity integer,"priceDeltaCents" integer,"sortOrder" integer,modifiers jsonb);
    total:=total+round((resolved->>'unitPriceCents')::numeric*quantity_milli/1000)::bigint;
    line_ids:=line_ids || jsonb_build_array(line_id);
  end loop;
  update public.orders set revision=revision+1,updated_at=now() where id=o.id;
  receipt:=jsonb_build_object('orderId',o.id,'acceptedAt',now(),'totalCents',total,'productionStatus','saved','lineIds',line_ids);
  insert into tickit_private.requests values(i.id,p_request_id,p_token_hash,p_lines,receipt);
  return receipt;
end $$;
revoke all on function public.tickit_api_submit(uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.tickit_api_submit(uuid,text,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
