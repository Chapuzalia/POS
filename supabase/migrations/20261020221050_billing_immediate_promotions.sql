-- migration-safety: expand
set lock_timeout = '5s';
set statement_timeout = '5min';
-- migration-safety-reviewed: CREATE OR REPLACE ROUTINE
-- migration-safety-reason: Preserve invoker signature and N-1 actions; attach verified schedule snapshots under tenant lock and keep billed amounts current during dunning.
-- Existing pending fiscal/accounting/ticket contracts require their own N-1 cleanup release;
-- no legacy surface is removed by this Billing expand.

alter table public.billing_accounts add column schedule_operation_id uuid;
alter table public.billing_accounts add constraint billing_accounts_schedule_operation_fk
  foreign key (schedule_operation_id) references public.billing_operations(id) not valid;
create index billing_accounts_schedule_operation_idx on public.billing_accounts(schedule_operation_id) where schedule_operation_id is not null;

create or replace function public.billing_transition(p_action text, p_data jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  a public.billing_accounts;
  next_account public.billing_accounts;
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
  elsif p_action = 'apply_error' then
    select * into op from public.billing_operations where id=(p_data->>'operationId')::uuid and tenant_id=tid for update;
    if op.id is null then raise exception 'BILLING_FORBIDDEN'; end if;
    if op.status <> 'applying' then return to_jsonb(op); end if;
    -- Only the server's first rejected mutation with no recorded economic resource may release.
    update public.billing_operations set
      status=case when coalesce((p_data->>'release')::boolean,false)
        and p_data->'error'->>'outcome'='rejected'
        and not (coalesce(result,'{}'::jsonb) ?| array['checkoutId','scheduleId','pendingInvoiceId'])
        then 'failed' else 'applying' end,
      result=coalesce(result,'{}'::jsonb)||jsonb_build_object('stripeError',p_data->'error'),updated_at=now()
      where id=op.id returning * into op;
    insert into public.billing_audit(tenant_id,actor_id,action,reason,details)
      values(tid,op.actor_id,'apply_error','Stripe mutation outcome',jsonb_build_object('operationId',op.id,'status',op.status,'error',p_data->'error'));
    return to_jsonb(op);
  elsif p_action = 'apply_result' then
    select * into op from public.billing_operations where id=(p_data->>'operationId')::uuid and tenant_id=tid for update;
    if op.status <> 'applying' then return to_jsonb(op); end if;
    update public.billing_operations set status=p_data->>'status',result=p_data->'result',effective_at=(p_data->>'effectiveAt')::timestamptz,updated_at=now() where id=op.id returning * into op;
    if op.stripe_params ? 'phases' and op.result->>'scheduleId' is not null then
      update public.billing_accounts set schedule_operation_id=op.id,revision=revision+1 where tenant_id=tid;
    end if;
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
      schedule_operation_id=case when coalesce((p_data->>'clearSchedule')::boolean,false) then null else schedule_operation_id end,
      billed_contract=case when p_data->'financialContract' is not null and p_data->'financialContract' <> 'null' then p_data->'financialContract' when p_data->'contract' is not null and p_data->'contract' <> 'null' then p_data->'contract' else billed_contract end,
      subscription_started_at=case when p_data->>'status' in ('active','trialing') then coalesce(subscription_started_at,now()) else subscription_started_at end,
      canceled_at=case when p_data->>'status'='canceled' then coalesce(canceled_at,now()) else null end,
      status=p_data->>'status',period_end=(p_data->>'periodEnd')::timestamptz,cancel_at_period_end=coalesce((p_data->>'cancelAtPeriodEnd')::boolean,false),
      last_payment_status=p_data->>'paymentStatus',
      delinquent_since=case when p_data->>'subscriptionId' is not null and p_data->>'status' in ('past_due','unpaid') then coalesce(delinquent_since,now()) else null end,
      last_reconciled_at=now(),sync_error=case when deferred then 'ENTITLEMENTS_PENDING_OPERATIONAL_CLOSE' else p_data->>'discrepancy' end,sync_token=null,sync_until=null,updated_at=now() where tenant_id=tid;
    -- Technical reconciliation timestamps/errors must not invalidate an otherwise unchanged quote.
    select * into next_account from public.billing_accounts where tenant_id=tid;
    if (to_jsonb(next_account) - array['revision','last_reconciled_at','sync_error','sync_token','sync_until','updated_at','last_attempt_at'])
      is distinct from (to_jsonb(a) - array['revision','last_reconciled_at','sync_error','sync_token','sync_until','updated_at','last_attempt_at']) then
      update public.billing_accounts set revision=revision+1 where tenant_id=tid;
    end if;
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
