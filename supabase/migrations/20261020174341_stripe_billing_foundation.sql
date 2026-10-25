-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: REVOKE
-- migration-safety-reason: New backend-only routines reject non-service callers; remove default PUBLIC/anon execution and grant authenticated/service_role as required by the migration checker.

create table public.billing_products (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{0,79}$'),
  kind text not null check (kind in ('plan','addon')),
  name text not null check (length(name) between 1 and 120),
  description text not null default '',
  scope text not null check (scope in ('tenant','venue','device')),
  feature_key text references public.platform_features(key),
  resource text check (resource in ('venues','devices')),
  active boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index billing_products_feature_idx on public.billing_products(feature_key);
create unique index billing_products_unique_feature_idx on public.billing_products(feature_key) where feature_key is not null;
create table public.billing_price_versions (
  id uuid primary key default gen_random_uuid(),
  product_key text not null references public.billing_products(key),
  interval text not null check (interval in ('month','year')),
  amount_cents integer not null check (amount_cents between 0 and 100000000),
  features text[] not null default '{}',
  limits jsonb not null default '{"venues":1,"devices":0}',
  included jsonb not null default '{}',
  maximum integer check (maximum between 0 and 100000),
  requires text[] not null default '{}',
  stripe_price_id text unique,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  check (not published or stripe_price_id is not null)
);
create index billing_price_versions_product_idx on public.billing_price_versions(product_key, interval, created_at desc);
create index billing_price_versions_actor_idx on public.billing_price_versions(created_by);
create table public.billing_accounts (
  tenant_id uuid primary key references public.tenants(id),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  source text not null default 'manual' check (source in ('manual','stripe')),
  status text not null default 'manual',
  subscription_started_at timestamptz,
  canceled_at timestamptz,
  legal_name text,
  tax_id text,
  email text,
  contract jsonb,
  billed_contract jsonb,
  revision integer not null default 0,
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  delinquent_since timestamptz,
  grace_days integer not null default 14 check (grace_days between 0 and 365),
  last_payment_status text,
  last_reconciled_at timestamptz,
  last_attempt_at timestamptz,
  sync_error text,
  sync_token uuid,
  sync_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index billing_accounts_reconcile_idx on public.billing_accounts(last_attempt_at) where stripe_customer_id is not null;
create table public.billing_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.billing_accounts(tenant_id),
  actor_id uuid not null references public.profiles(id),
  kind text not null check (kind in ('change','cancel','cancel_now')),
  status text not null check (status in ('quoted','applying','payment_pending','scheduled','completed','failed','expired')),
  expected_revision integer not null,
  contract jsonb,
  restore_contract jsonb,
  timing text not null check (timing in ('immediate','period_end')),
  preview jsonb not null,
  stripe_params jsonb not null,
  result jsonb,
  reason text not null check (length(reason) between 1 and 500),
  proration_date bigint not null,
  expires_at timestamptz not null,
  effective_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index billing_operations_tenant_idx on public.billing_operations(tenant_id, created_at desc);
create index billing_operations_actor_idx on public.billing_operations(actor_id);
create unique index billing_operations_one_inflight_idx on public.billing_operations(tenant_id)
  where status in ('applying','payment_pending','scheduled');
create table public.billing_invoices (
  stripe_invoice_id text primary key,
  tenant_id uuid not null references public.billing_accounts(tenant_id),
  status text not null,
  currency text not null check (currency = 'eur'),
  amount_due_cents bigint not null,
  amount_paid_cents bigint not null,
  paid_excluding_tax_cents bigint not null default 0,
  issuer_snapshot jsonb not null default '{}',
  customer_snapshot jsonb not null default '{}',
  fiscal_export_status text not null default 'pending_review' check (fiscal_export_status in ('pending_review','exported','failed')),
  fiscal_external_reference text,
  hosted_invoice_url text,
  invoice_pdf text,
  number text,
  created_at timestamptz not null,
  paid_at timestamptz
);
create index billing_invoices_tenant_idx on public.billing_invoices(tenant_id, created_at desc);
create table public.billing_stripe_events (
  event_id text primary key,
  event_type text not null,
  stripe_created bigint not null,
  stripe_customer_id text,
  status text not null default 'received' check (status in ('received','processing','completed','failed','ignored')),
  attempts integer not null default 0,
  error_code text,
  lock_until timestamptz,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index billing_stripe_events_status_idx on public.billing_stripe_events(status, created_at);
create index billing_stripe_events_customer_idx on public.billing_stripe_events(stripe_customer_id);
create table public.billing_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  actor_id uuid references public.profiles(id),
  action text not null,
  reason text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index billing_audit_tenant_idx on public.billing_audit(tenant_id, created_at desc);
create index billing_audit_actor_idx on public.billing_audit(actor_id);

-- No tariffs or invented plans are seeded. Existing capabilities become inactive drafts.
insert into public.billing_products(key, kind, name, description, scope, feature_key, sort_order)
select key, 'addon', name, description,
  case when key in ('production','reservations') then 'venue' else 'tenant' end,
  key, sort_order
from public.platform_features where not is_core and is_active
  and key not in ('discounts','inventory_recipes','supplier_documents','supplier_document_scanning','multi_device');
-- Manual rights remain authoritative until an explicitly accepted, paid onboarding.
insert into public.billing_accounts(tenant_id) select id from public.tenants;

alter table public.billing_products enable row level security;
alter table public.billing_price_versions enable row level security;
alter table public.billing_accounts enable row level security;
alter table public.billing_operations enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_stripe_events enable row level security;
alter table public.billing_audit enable row level security;
-- All writes pass through the authenticated Edge service, never direct browser writes.
grant select, insert, update, delete on public.billing_products, public.billing_price_versions,
  public.billing_accounts, public.billing_operations, public.billing_invoices,
  public.billing_stripe_events, public.billing_audit to service_role;
grant select on public.billing_accounts, public.billing_invoices to authenticated;
create policy billing_accounts_owner_read on public.billing_accounts for select to authenticated using (
  exists (select 1 from public.tenant_memberships m where m.tenant_id = billing_accounts.tenant_id and m.user_id = (select auth.uid()) and m.role = 'owner' and m.is_active)
);
create policy billing_invoices_owner_read on public.billing_invoices for select to authenticated using (
  exists (select 1 from public.tenant_memberships m where m.tenant_id = billing_invoices.tenant_id and m.user_id = (select auth.uid()) and m.role = 'owner' and m.is_active)
);

create function public.billing_immutable_version() returns trigger language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'stripe_price_id' - 'published') is distinct from (to_jsonb(old) - 'stripe_price_id' - 'published')
    or (old.stripe_price_id is not null and new.stripe_price_id is distinct from old.stripe_price_id)
    or (old.published and not new.published) then raise exception 'BILLING_IMMUTABLE_VERSION'; end if;
  return new;
end;
$$;
create trigger billing_price_version_immutable before update on public.billing_price_versions
for each row execute function public.billing_immutable_version();

-- A single transaction boundary for state changes. Caller is a trusted Edge Function.
-- Invoker security and explicit service guard also apply to callers with function EXECUTE.
create function public.billing_transition(p_action text, p_data jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a public.billing_accounts;
  op public.billing_operations;
  ev public.billing_stripe_events;
  tid uuid := (p_data->>'tenantId')::uuid;
  actor uuid := (p_data->>'actorId')::uuid;
  token uuid;
  feature text;
  venue record;
  addon jsonb;
  c jsonb;
  deferred boolean := false;
  feature_keys text[];
  v public.billing_price_versions;
begin
  if current_user not in ('service_role','postgres','supabase_admin') then raise exception 'BILLING_FORBIDDEN' using errcode = '42501'; end if;
  if p_action = 'event_claim' then
    insert into public.billing_stripe_events(event_id,event_type,stripe_created,stripe_customer_id)
    values(p_data->>'id',p_data->>'type',(p_data->>'created')::bigint,p_data->>'customer') on conflict do nothing;
    select * into ev from public.billing_stripe_events where event_id = p_data->>'id' for update;
    if ev.status in ('completed','ignored') then return '{"claimed":false}'; end if;
    if ev.lock_until > now() then raise exception 'BILLING_EVENT_BUSY'; end if;
    update public.billing_stripe_events set status='processing', attempts=attempts+1, lock_until=now()+interval '2 minutes' where event_id=ev.event_id;
    return '{"claimed":true}';
  elsif p_action = 'event_finish' then
    update public.billing_stripe_events set status=p_data->>'status',error_code=p_data->>'error',lock_until=null,processed_at=now() where event_id=p_data->>'id';
    return '{}';
  elsif p_action = 'catalog_save' then
    if exists(select 1 from public.billing_price_versions where product_key=p_data->'product'->>'key') and exists(select 1 from public.billing_products where key=p_data->'product'->>'key'
      and (kind <> p_data->'product'->>'kind' or scope <> p_data->'product'->>'scope' or feature_key is distinct from p_data->'product'->>'featureKey' or resource is distinct from p_data->'product'->>'resource')) then raise exception 'BILLING_PRODUCT_IDENTITY_IMMUTABLE'; end if;
    insert into public.billing_products(key,kind,name,description,scope,feature_key,resource,active,sort_order)
    values(p_data->'product'->>'key',p_data->'product'->>'kind',p_data->'product'->>'name',p_data->'product'->>'description',p_data->'product'->>'scope',p_data->'product'->>'featureKey',p_data->'product'->>'resource',(p_data->'product'->>'active')::boolean,(p_data->'product'->>'sortOrder')::integer)
    on conflict(key) do update set kind=excluded.kind,scope=excluded.scope,feature_key=excluded.feature_key,resource=excluded.resource,
      name=excluded.name,description=excluded.description,active=excluded.active,sort_order=excluded.sort_order;
    if p_data->'version' is not null and p_data->'version' <> 'null' then
      insert into public.billing_price_versions(product_key,interval,amount_cents,features,limits,included,maximum,requires,created_by)
      values(p_data->'product'->>'key',p_data->'version'->>'interval',(p_data->'version'->>'amountCents')::integer,
        array(select jsonb_array_elements_text(p_data->'version'->'features')),p_data->'version'->'limits',p_data->'version'->'included',
        (p_data->'version'->>'maximum')::integer,array(select jsonb_array_elements_text(p_data->'version'->'requires')),actor) returning * into v;
    end if;
    insert into public.billing_audit(actor_id,action,reason,details) values(actor,'catalog_save',p_data->>'reason',jsonb_build_object('key',p_data->'product'->>'key','versionId',v.id));
    return to_jsonb(v);
  end if;

  insert into public.billing_accounts(tenant_id) values(tid) on conflict do nothing;
  select * into a from public.billing_accounts where tenant_id=tid for update;
  if p_action = 'link_customer' then
    if a.stripe_customer_id is not null and a.stripe_customer_id <> p_data->>'customerId' then raise exception 'BILLING_CUSTOMER_CONFLICT'; end if;
    update public.billing_accounts set stripe_customer_id=p_data->>'customerId' where tenant_id=tid;
    return '{}';
  elsif p_action = 'sync_claim' then
    if a.sync_until > now() then raise exception 'BILLING_SYNC_BUSY'; end if;
    token := gen_random_uuid();
    update public.billing_accounts set sync_token=token,sync_until=now()+interval '2 minutes',last_attempt_at=now() where tenant_id=tid;
    return jsonb_build_object('token',token);
  elsif p_action = 'sync_fail' then
    update public.billing_accounts set sync_token=null,sync_until=null,sync_error='STRIPE_UNAVAILABLE' where tenant_id=tid and sync_token=(p_data->>'token')::uuid;
    return '{}';
  elsif p_action = 'quote' then
    if a.revision <> (p_data->>'revision')::integer or a.sync_until > now() then raise exception 'BILLING_STALE'; end if;
    insert into public.billing_operations(tenant_id,actor_id,kind,status,expected_revision,contract,restore_contract,timing,preview,stripe_params,reason,proration_date,expires_at)
    values(tid,actor,p_data->>'kind','quoted',a.revision,p_data->'contract',p_data->'restoreContract',p_data->>'timing',p_data->'preview',p_data->'stripeParams',p_data->>'reason',(p_data->>'prorationDate')::bigint,now()+interval '5 minutes') returning * into op;
    return to_jsonb(op);
  elsif p_action = 'apply_claim' then
    select * into op from public.billing_operations where id=(p_data->>'operationId')::uuid and tenant_id=tid for update;
    if op.id is null or op.actor_id <> actor then raise exception 'BILLING_FORBIDDEN'; end if;
    if op.status <> 'quoted' then return to_jsonb(op); end if;
    if op.expires_at < now() or op.expected_revision <> a.revision or a.sync_until > now() then raise exception 'BILLING_STALE'; end if;
    update public.billing_operations set status='applying',updated_at=now() where id=op.id returning * into op;
    insert into public.billing_audit(tenant_id,actor_id,action,reason,details) values(tid,actor,'apply_'||op.kind,op.reason,jsonb_build_object('operationId',op.id,'preview',op.preview));
    return to_jsonb(op);
  elsif p_action = 'apply_result' then
    select * into op from public.billing_operations where id=(p_data->>'operationId')::uuid and tenant_id=tid for update;
    if op.status <> 'applying' then return to_jsonb(op); end if;
    update public.billing_operations set status=p_data->>'status',result=p_data->'result',effective_at=(p_data->>'effectiveAt')::timestamptz,updated_at=now() where id=op.id returning * into op;
    return to_jsonb(op);
  elsif p_action = 'sync_commit' then
    if a.sync_token is distinct from (p_data->>'token')::uuid or a.sync_until < now() then raise exception 'BILLING_STALE_SYNC'; end if;
    c := p_data->'contract';
    -- A voluntary downgrade may finish financially while a shift is still open.
    -- Defer only the access reduction; never close cash/orders or touch sale records.
    if c is not null and c <> 'null' and a.contract is not null and (
      exists(select 1 from jsonb_array_elements_text(a.contract->'features') as old_feature(value) where not ((c->'features') ? old_feature.value))
      or (c->'limits'->>'venues')::integer < (a.contract->'limits'->>'venues')::integer
      or (c->'limits'->>'devices')::integer < (a.contract->'limits'->>'devices')::integer
      or exists(select 1 from jsonb_array_elements(a.contract->'addons') old_addon
        cross join lateral jsonb_array_elements_text(old_addon->'venueIds') as old_venue(value)
        where old_addon->>'scope'='venue' and not exists(select 1 from jsonb_array_elements(c->'addons') new_addon
          where new_addon->>'featureKey'=old_addon->>'featureKey' and (new_addon->'venueIds') ? old_venue.value))
    ) and (exists(select 1 from public.cash_sessions where tenant_id=tid and status='open')
      or exists(select 1 from public.orders where tenant_id=tid and status in ('open','carried_forward'))) then
      c := null; deferred := true;
    end if;
    if c is not null and c <> 'null' then
      perform set_config('tickit.billing_projection',tid::text,true);
      -- Protect operational capacity even when terminals/locales were added after a quote.
      update public.tenants set max_venues=greatest((c->'limits'->>'venues')::integer,(select count(*)::integer from public.venues where tenant_id=tid)),
        max_devices=greatest((c->'limits'->>'devices')::integer,(select count(*)::integer from public.devices where tenant_id=tid and is_active)), updated_at=now() where id=tid;
      feature_keys := array(select jsonb_array_elements_text(c->'features'));
      -- Only a confirmed contract takes ownership of the old assignment projection.
      delete from public.tenant_feature_assignments where tenant_id=tid and not (feature_key=any(feature_keys));
      insert into public.tenant_feature_assignments(tenant_id,feature_key) select tid,f.key from public.platform_features f where f.key=any(feature_keys) on conflict do nothing;
      -- Explicit per-venue rows close the legacy default-true behavior for scoped addons.
      for addon in select value from jsonb_array_elements(c->'addons') where value->>'scope'='venue' and value->>'featureKey' is not null loop
        for venue in select id from public.venues where tenant_id=tid loop
          insert into public.venue_addon_assignments(tenant_id,venue_id,addon_key,is_enabled)
          values(tid,venue.id,addon->>'featureKey',(addon->'venueIds') ? venue.id::text)
          on conflict(venue_id,addon_key) do update set is_enabled=excluded.is_enabled,updated_at=now();
        end loop;
      end loop;
      update public.billing_accounts set source='stripe',contract=c where tenant_id=tid;
    end if;
    update public.billing_accounts set stripe_customer_id=p_data->>'customerId',stripe_subscription_id=p_data->>'subscriptionId',
      billed_contract=case when p_data->'contract' is not null and p_data->'contract' <> 'null' then p_data->'contract' else billed_contract end,
      subscription_started_at=case when p_data->>'status' in ('active','trialing') then coalesce(subscription_started_at,now()) else subscription_started_at end,
      canceled_at=case when p_data->>'status'='canceled' then coalesce(canceled_at,now()) else null end,
      status=p_data->>'status',period_end=(p_data->>'periodEnd')::timestamptz,cancel_at_period_end=coalesce((p_data->>'cancelAtPeriodEnd')::boolean,false),
      last_payment_status=p_data->>'paymentStatus',
      delinquent_since=case when p_data->>'status' in ('active','trialing') then null else coalesce(delinquent_since,now()) end,
      last_reconciled_at=now(),sync_error=case when deferred then 'ENTITLEMENTS_PENDING_OPERATIONAL_CLOSE' else p_data->>'discrepancy' end,revision=revision+1,sync_token=null,sync_until=null,updated_at=now() where tenant_id=tid;
    if not deferred and p_data->>'completedOperationId' is not null then
      update public.billing_operations set status='completed',updated_at=now() where id=(p_data->>'completedOperationId')::uuid and tenant_id=tid;
    end if;
    insert into public.billing_audit(tenant_id,action,reason,details) values(tid,'reconcile','Stripe snapshot',jsonb_build_object('status',p_data->>'status','discrepancy',p_data->>'discrepancy'));
    return '{}';
  elsif p_action = 'settings' then
    update public.billing_accounts set grace_days=(p_data->>'graceDays')::integer,legal_name=p_data->>'legalName',tax_id=p_data->>'taxId',email=p_data->>'email' where tenant_id=tid;
    insert into public.billing_audit(tenant_id,actor_id,action,reason) values(tid,actor,'settings',p_data->>'reason');
    return '{}';
  end if;
  raise exception 'BILLING_UNKNOWN_TRANSITION';
end;
$$;
revoke all on function public.billing_transition(text,jsonb), public.billing_immutable_version() from public, anon;
grant execute on function public.billing_transition(text,jsonb), public.billing_immutable_version() to authenticated, service_role;

-- Legacy admin screens must not bypass paid capacity or per-venue allocations.
create function public.billing_guard_legacy_write() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  tid uuid;
  c jsonb;
begin
  if tg_table_name = 'tenants' then tid := new.id;
  elsif tg_op = 'DELETE' then tid := old.tenant_id;
  else tid := new.tenant_id; end if;
  select contract into c from public.billing_accounts where tenant_id=tid and source='stripe';
  if c is null or (current_user in ('service_role','postgres','supabase_admin') and current_setting('tickit.billing_projection',true)=tid::text) then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_table_name='tenants' then
    if new.max_venues is distinct from old.max_venues or new.max_devices is distinct from old.max_devices then raise exception 'BILLING_USE_COMMERCIAL_CHANGE'; end if;
  elsif tg_table_name='tenant_feature_assignments' then
    raise exception 'BILLING_USE_COMMERCIAL_CHANGE';
  elsif tg_table_name='venue_addon_assignments' and tg_op = 'DELETE' then
    -- The legacy RPC deletes dependency rows; retain an explicit disabled row so
    -- its historical default-true lookup cannot re-enable an unassigned addon.
    update public.venue_addon_assignments set is_enabled=false,updated_at=now()
      where venue_id=old.venue_id and addon_key=old.addon_key;
    return null;
  elsif tg_table_name='venue_addon_assignments' and tg_op <> 'DELETE' and new.is_enabled then
    if exists(select 1 from jsonb_array_elements(c->'addons') addon where addon->>'featureKey'=new.addon_key and addon->>'scope'='venue'
      and not ((addon->'venueIds') ? new.venue_id::text)) then raise exception 'BILLING_VENUE_NOT_CONTRACTED'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger billing_guard_tenant_limits before update on public.tenants for each row execute function public.billing_guard_legacy_write();
create trigger billing_guard_tenant_features before insert or update or delete on public.tenant_feature_assignments for each row execute function public.billing_guard_legacy_write();
create trigger billing_guard_venue_addons before insert or update or delete on public.venue_addon_assignments for each row execute function public.billing_guard_legacy_write();

create function public.billing_initialize_venue() returns trigger language plpgsql security invoker set search_path = '' as $$
declare c jsonb; addon jsonb;
begin
  select contract into c from public.billing_accounts where tenant_id=new.tenant_id and source='stripe';
  if c is not null then
    for addon in select value from jsonb_array_elements(c->'addons') where value->>'scope'='venue' and value->>'featureKey' is not null loop
      insert into public.venue_addon_assignments(tenant_id,venue_id,addon_key,is_enabled)
      values(new.tenant_id,new.id,addon->>'featureKey',false) on conflict do nothing;
    end loop;
  end if;
  return new;
end;
$$;
create trigger billing_initialize_venue after insert on public.venues for each row execute function public.billing_initialize_venue();
revoke all on function public.billing_guard_legacy_write(), public.billing_initialize_venue() from public, anon;
grant execute on function public.billing_guard_legacy_write(), public.billing_initialize_venue() to authenticated, service_role;

-- Replaces the existing feature refresh read for venue-bound sessions. It only
-- reads local indexed assignments; there is no billing/Stripe call on a sale.
create function public.get_current_billing_venue_features(p_tenant_id uuid,p_venue_id uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.user_has_venue_access(p_tenant_id,p_venue_id)
    or not exists(select 1 from public.venues where id=p_venue_id and tenant_id=p_tenant_id and is_active) then
    raise exception 'BILLING_VENUE_FORBIDDEN' using errcode='42501';
  end if;
  return array(
    select feature_key from unnest(public.get_current_tenant_features(p_tenant_id)) as feature(feature_key)
    where not exists(select 1 from public.venue_addon_assignments assignment
      where assignment.tenant_id=p_tenant_id and assignment.venue_id=p_venue_id
        and assignment.addon_key=case feature.feature_key when 'discounts' then 'promotions' when 'inventory_recipes' then 'costing' when 'supplier_documents' then 'purchases' when 'supplier_document_scanning' then 'document_ai' else feature.feature_key end
        and not assignment.is_enabled)
    order by feature_key
  );
end;
$$;
revoke all on function public.get_current_billing_venue_features(uuid,uuid) from public, anon;
grant execute on function public.get_current_billing_venue_features(uuid,uuid) to authenticated, service_role;
