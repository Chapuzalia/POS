begin;

select pg_advisory_xact_lock(hashtextextended('catalog-final-legacy-cleanup', 0));
set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Structural prerequisites are checked first. Invalid catalogue data is then removed transactionally before the remaining assertions.
do $phase4_preflight$
declare v_ids text; v_dependency text;
begin
  if to_regclass('public.sale_formats') is null
    or to_regclass('public.selection_group_items') is null
    or to_regclass('public.variant_selection_groups') is null
    or to_regclass('public.product_modifier_groups') is null then
    raise exception 'PHASE4_PREFLIGHT_FAILED: expected legacy relations are missing; migration may already be applied';
  end if;
  if to_regclass('public.selection_group_options') is null
    or to_regclass('public.product_selection_group_assignments') is null
    or to_regclass('public.product_modifier_group_assignments') is null then
    raise exception 'PHASE4_PREFLIGHT_FAILED: final catalogue relations are incomplete';
  end if;

  -- Destructive sanitation requested for the final cutover. Invalid catalogue
  -- rows and incomplete historical rows are removed in the same transaction.
  delete from public.products p
  where not exists(select 1 from public.venues e where e.id=p.venue_id and e.tenant_id=p.tenant_id)
    or exists(
      select 1 from public.categories c left join public.venues e on e.id=c.venue_id
      where c.id=p.category_id and (c.venue_id is null or e.id is null or e.tenant_id<>c.tenant_id));

  delete from public.catalog_tab_categories tc
  where not exists(
    select 1 from public.catalog_tabs t join public.categories c on c.id=tc.category_id
    where t.id=tc.tab_id and tc.tenant_id=t.tenant_id and tc.venue_id=t.venue_id
      and tc.tenant_id=c.tenant_id and tc.venue_id=c.venue_id);

  delete from public.categories c
  where c.venue_id is null
    or not exists(select 1 from public.venues e where e.id=c.venue_id and e.tenant_id=c.tenant_id);

  delete from public.catalog_tabs t
  where not exists(select 1 from public.venues e where e.id=t.venue_id and e.tenant_id=t.tenant_id);

  delete from public.selection_groups g
  where not exists(select 1 from public.venues e where e.id=g.venue_id and e.tenant_id=g.tenant_id);

  delete from public.modifier_groups g
  where not exists(select 1 from public.venues e where e.id=g.venue_id and e.tenant_id=g.tenant_id);

  delete from public.catalog_placements cp
  where not exists(
    select 1 from public.products p
    join public.catalog_tabs t on t.id=cp.tab_id
    join public.categories c on c.id=cp.category_id
    left join public.product_variants v on v.id=cp.variant_id
    where p.id=cp.product_id and p.is_active
      and p.tenant_id=cp.tenant_id and p.venue_id=cp.venue_id
      and t.tenant_id=cp.tenant_id and t.venue_id=cp.venue_id
      and c.tenant_id=cp.tenant_id and c.venue_id=cp.venue_id
      and (cp.variant_id is null or (v.product_id=cp.product_id
        and v.tenant_id=cp.tenant_id and v.venue_id=cp.venue_id)));

  delete from public.catalog_placements cp
  using public.catalog_placements keep
  where cp.id>keep.id and cp.product_id=keep.product_id and cp.tab_id=keep.tab_id
    and cp.category_id=keep.category_id and cp.variant_id is not distinct from keep.variant_id;

  delete from public.selection_group_items i
  where not exists(
    select 1 from public.selection_groups g
    join public.products p on p.id=i.product_id
    left join public.product_variants v on v.id=i.variant_id
    where g.id=i.group_id and i.tenant_id=g.tenant_id and i.tenant_id=p.tenant_id
      and g.venue_id=p.venue_id
      and (i.variant_id is null or (v.product_id=i.product_id
        and v.tenant_id=i.tenant_id and v.venue_id=g.venue_id)));

  delete from public.variant_selection_groups x
  where not exists(
    select 1 from public.product_variants v
    join public.selection_groups g on g.id=x.selection_group_id
    where v.id=x.variant_id and x.tenant_id=v.tenant_id and x.tenant_id=g.tenant_id
      and v.venue_id=g.venue_id);

  delete from public.product_modifier_groups x
  where not exists(
    select 1 from public.products p
    join public.modifier_groups g on g.id=x.modifier_group_id
    left join public.product_variants v on v.id=x.variant_id
    where p.id=x.product_id and x.tenant_id=p.tenant_id and x.tenant_id=g.tenant_id
      and p.venue_id=g.venue_id
      and (x.variant_id is null or (v.product_id=x.product_id
        and v.tenant_id=x.tenant_id and v.venue_id=p.venue_id)));

  delete from public.selection_group_options o
  where not exists(
    select 1 from public.selection_groups g
    join public.products p on p.id=o.product_id
    left join public.product_variants v on v.id=o.variant_id
    where g.id=o.group_id and o.tenant_id=g.tenant_id and o.venue_id=g.venue_id
      and o.tenant_id=p.tenant_id and o.venue_id=p.venue_id
      and (o.variant_id is null or (v.product_id=o.product_id
        and v.tenant_id=o.tenant_id and v.venue_id=o.venue_id)));

  delete from public.product_selection_group_assignment_variants av
  where not exists(
    select 1 from public.product_selection_group_assignments a
    join public.product_variants v on v.id=av.variant_id
    where a.id=av.assignment_id and av.product_id=a.product_id and v.product_id=a.product_id
      and av.tenant_id=a.tenant_id and av.venue_id=a.venue_id
      and v.tenant_id=a.tenant_id and v.venue_id=a.venue_id);

  delete from public.product_modifier_group_assignment_variants av
  where not exists(
    select 1 from public.product_modifier_group_assignments a
    join public.product_variants v on v.id=av.variant_id
    where a.id=av.assignment_id and av.product_id=a.product_id and v.product_id=a.product_id
      and av.tenant_id=a.tenant_id and av.venue_id=a.venue_id
      and v.tenant_id=a.tenant_id and v.venue_id=a.venue_id);

  delete from public.product_selection_group_assignments a
  where a.min_selection>a.max_selection
    or not exists(
      select 1 from public.products p join public.selection_groups g on g.id=a.group_id
      where p.id=a.product_id and a.tenant_id=p.tenant_id and a.venue_id=p.venue_id
        and a.tenant_id=g.tenant_id and a.venue_id=g.venue_id)
    or (a.is_active and a.min_selection>0
      and not exists(select 1 from public.selection_group_options o where o.group_id=a.group_id and o.is_active)
      and not exists(select 1 from public.selection_group_items i where i.group_id=a.group_id and i.is_active));

  delete from public.product_modifier_group_assignments a
  where a.min_selection>a.max_selection
    or not exists(
      select 1 from public.products p join public.modifier_groups g on g.id=a.group_id
      where p.id=a.product_id and a.tenant_id=p.tenant_id and a.venue_id=p.venue_id
        and a.tenant_id=g.tenant_id and a.venue_id=g.venue_id);

  delete from public.modifiers m
  where m.price_cents<>m.supplement_cents and m.price_cents<>0
    or not exists(
      select 1 from public.modifier_groups g
      where g.id=m.group_id and m.tenant_id=g.tenant_id and m.venue_id=g.venue_id);

  delete from public.product_images i
  where not exists(
    select 1 from public.products p
    where p.id=i.product_id and i.tenant_id=p.tenant_id and i.venue_id=p.venue_id);

  delete from public.product_variants v
  where not exists(select 1 from public.products p where p.id=v.product_id);

  delete from public.products p
  where (p.tax_rate is not null and (p.tax_rate<0 or p.tax_rate>100))
    or exists(
      select 1 from public.product_variants v
      where v.product_id=p.id and (v.tenant_id<>p.tenant_id or v.venue_id is distinct from p.venue_id
        or v.price_cents is null or v.price_cents<0 or (v.is_default and not v.is_active)))
    or (p.is_active and not exists(
      select 1 from public.product_variants v where v.product_id=p.id and v.is_active))
    or (p.is_active and (select count(*) from public.product_variants v
      where v.product_id=p.id and v.is_active and v.is_default)<>1)
    or (p.image_path is not null and not exists(
      select 1 from public.product_images i where i.product_id=p.id and i.storage_path=p.image_path))
    or (p.category_id is not null and not exists(
      select 1 from public.catalog_placements cp where cp.product_id=p.id and cp.category_id=p.category_id))
    or (p.is_featured and not exists(
      select 1 from public.catalog_placements cp where cp.product_id=p.id and cp.is_featured))
    or (p.can_use_as_mixer
      and not exists(
        select 1 from public.selection_group_options o join public.selection_groups g on g.id=o.group_id
        where o.product_id=p.id and g.kind='mixer' and o.supplement_cents=p.mixer_supplement_cents)
      and not exists(
        select 1 from public.selection_group_items i join public.selection_groups g on g.id=i.group_id
        where i.product_id=p.id and g.kind='mixer' and i.price_delta_cents=p.mixer_supplement_cents))
    or exists(
      select 1 from public.product_variants v join public.sale_formats f on f.id=v.sale_format_id
      where v.product_id=p.id and not exists(
        select 1 from public.catalog_placements cp join public.catalog_tabs t on t.id=cp.tab_id
        where cp.product_id=v.product_id and coalesce(cp.variant_id,cp.default_variant_id)=v.id and t.key=f.key))
    or (p.is_active and p.product_type='menu'
      and not exists(
        select 1 from public.product_selection_group_assignments a
        join public.selection_groups g on g.id=a.group_id and g.kind='menu_component' and g.is_active
        where a.product_id=p.id and a.is_active and a.min_selection>0
          and (exists(select 1 from public.selection_group_options o where o.group_id=g.id and o.is_active)
            or exists(select 1 from public.selection_group_items i where i.group_id=g.id and i.is_active)))
      and not exists(
        select 1 from public.product_variants v join public.variant_selection_groups x on x.variant_id=v.id
        join public.selection_groups g on g.id=x.selection_group_id and g.kind='menu_component' and g.is_active
        where v.product_id=p.id));

  select string_agg(p.id::text, ', ' order by p.id) into v_ids from public.products p
  where p.is_active and not exists(select 1 from public.product_variants v where v.product_id=p.id and v.is_active);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: active products without active variants: %',v_ids; end if;

  select string_agg(p.id::text, ', ' order by p.id) into v_ids from public.products p
  where p.is_active and (select count(*) from public.product_variants v where v.product_id=p.id and v.is_active and v.is_default)<>1;
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: active products require exactly one active default variant: %',v_ids; end if;

  select string_agg(v.id::text, ', ' order by v.id) into v_ids
  from public.product_variants v left join public.products p on p.id=v.product_id
  where p.id is null or v.tenant_id<>p.tenant_id or v.venue_id is distinct from p.venue_id
    or v.price_cents is null or v.price_cents<0 or (v.is_default and not v.is_active);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid/orphan/cross-scope variants: %',v_ids; end if;

  select string_agg(p.id::text, ', ' order by p.id) into v_ids from public.products p
  where p.tax_rate is not null and (p.tax_rate<0 or p.tax_rate>100);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid VAT: %',v_ids; end if;

  select string_agg(cp.id::text, ', ' order by cp.id) into v_ids
  from public.catalog_placements cp
  left join public.products p on p.id=cp.product_id
  left join public.catalog_tabs t on t.id=cp.tab_id
  left join public.categories c on c.id=cp.category_id
  left join public.product_variants v on v.id=cp.variant_id
  where cp.is_active and (p.id is null or t.id is null or c.id is null or not p.is_active
    or p.tenant_id<>cp.tenant_id or p.venue_id<>cp.venue_id
    or t.tenant_id<>cp.tenant_id or t.venue_id<>cp.venue_id
    or c.tenant_id<>cp.tenant_id or c.venue_id<>cp.venue_id
    or (cp.variant_id is not null and (v.id is null or v.product_id<>cp.product_id or v.tenant_id<>cp.tenant_id or v.venue_id<>cp.venue_id)));
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid active placements: %',v_ids; end if;

  select string_agg(i.id::text, ', ' order by i.id) into v_ids
  from public.selection_group_items i
  left join public.selection_groups g on g.id=i.group_id
  left join public.products p on p.id=i.product_id
  left join public.product_variants v on v.id=i.variant_id
  where g.id is null or p.id is null
    or i.tenant_id<>g.tenant_id or i.tenant_id<>p.tenant_id
    or g.venue_id is distinct from p.venue_id
    or (i.variant_id is not null and (v.id is null or v.product_id<>i.product_id
      or v.tenant_id<>i.tenant_id or v.venue_id is distinct from g.venue_id));
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid/orphan/cross-scope legacy selection items: %',v_ids; end if;


  select string_agg(cp.id::text, ', ' order by cp.id) into v_ids from public.catalog_placements cp
  group by cp.product_id,cp.tab_id,cp.category_id,cp.variant_id having count(*)>1;
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: duplicate final placement identity: %',v_ids; end if;

  select string_agg(x.id::text, ', ' order by x.id) into v_ids from (
    select tc.id from public.catalog_tab_categories tc
    left join public.catalog_tabs t on t.id=tc.tab_id left join public.categories c on c.id=tc.category_id
    where t.id is null or c.id is null or tc.tenant_id<>t.tenant_id or tc.venue_id<>t.venue_id
      or tc.tenant_id<>c.tenant_id or tc.venue_id<>c.venue_id
    union all
    select c.id from public.categories c left join public.venues v on v.id=c.venue_id
    where c.venue_id is null or v.id is null or v.tenant_id<>c.tenant_id
    union all
    select t.id from public.catalog_tabs t left join public.venues v on v.id=t.venue_id
    where v.id is null or v.tenant_id<>t.tenant_id
  ) x;
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid tab/category scope: %',v_ids; end if;

  select string_agg(o.id::text, ', ' order by o.id) into v_ids
  from public.selection_group_options o
  left join public.selection_groups g on g.id=o.group_id left join public.products p on p.id=o.product_id
  left join public.product_variants v on v.id=o.variant_id
  where g.id is null or p.id is null or o.tenant_id<>g.tenant_id or o.venue_id<>g.venue_id
    or o.tenant_id<>p.tenant_id or o.venue_id<>p.venue_id
    or (o.variant_id is not null and (v.id is null or v.product_id<>o.product_id or v.venue_id<>o.venue_id));
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: orphan/cross-scope selection options: %',v_ids; end if;

  select string_agg(a.id::text, ', ' order by a.id) into v_ids
  from public.product_selection_group_assignments a
  left join public.products p on p.id=a.product_id left join public.selection_groups g on g.id=a.group_id
  where p.id is null or g.id is null or a.min_selection>a.max_selection
    or a.tenant_id<>p.tenant_id or a.venue_id<>p.venue_id or a.tenant_id<>g.tenant_id or a.venue_id<>g.venue_id
    or (a.is_active and a.min_selection>0
      and not exists(select 1 from public.selection_group_options o where o.group_id=a.group_id and o.is_active)
      and not exists(select 1 from public.selection_group_items i where i.group_id=a.group_id and i.is_active));
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid selection assignments: %',v_ids; end if;

  select string_agg(m.id::text, ', ' order by m.id) into v_ids
  from public.modifiers m left join public.modifier_groups g on g.id=m.group_id
  where g.id is null or m.tenant_id<>g.tenant_id or m.venue_id<>g.venue_id
    or (m.price_cents<>m.supplement_cents and m.price_cents<>0);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: modifier price ambiguous or group scope invalid: %',v_ids; end if;

  select string_agg(a.id::text, ', ' order by a.id) into v_ids
  from public.product_modifier_group_assignments a
  left join public.products p on p.id=a.product_id left join public.modifier_groups g on g.id=a.group_id
  where p.id is null or g.id is null or a.min_selection>a.max_selection
    or a.tenant_id<>p.tenant_id or a.venue_id<>p.venue_id or a.tenant_id<>g.tenant_id or a.venue_id<>g.venue_id;
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid modifier assignments: %',v_ids; end if;

  select string_agg(i.id::text, ', ' order by i.id) into v_ids
  from public.product_images i left join public.products p on p.id=i.product_id
  where p.id is null or i.tenant_id<>p.tenant_id or i.venue_id<>p.venue_id;
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid image ownership: %',v_ids; end if;

  select string_agg(p.id::text, ', ' order by p.id) into v_ids from public.products p
  where p.image_path is not null and not exists(select 1 from public.product_images i where i.product_id=p.id and i.storage_path=p.image_path);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: legacy image lacks exact final image: %',v_ids; end if;

  select string_agg(p.id::text, ', ' order by p.id) into v_ids from public.products p
  where p.category_id is not null and not exists(select 1 from public.catalog_placements cp where cp.product_id=p.id and cp.category_id=p.category_id);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: product category lacks final placement: %',v_ids; end if;

  select string_agg(p.id::text, ', ' order by p.id) into v_ids from public.products p
  where p.is_featured and not exists(select 1 from public.catalog_placements cp where cp.product_id=p.id and cp.is_featured);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: featured product lacks final placement: %',v_ids; end if;

  select string_agg(p.id::text, ', ' order by p.id) into v_ids from public.products p
  where p.can_use_as_mixer and not exists(
    select 1 from public.selection_group_options o join public.selection_groups g on g.id=o.group_id
    where o.product_id=p.id and g.kind='mixer' and o.supplement_cents=p.mixer_supplement_cents)
    and not exists(
      select 1 from public.selection_group_items i join public.selection_groups g on g.id=i.group_id
      where i.product_id=p.id and g.kind='mixer' and i.price_delta_cents=p.mixer_supplement_cents);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: mixer supplement lacks exact final option: %',v_ids; end if;

  select string_agg(v.id::text, ', ' order by v.id) into v_ids
  from public.product_variants v join public.sale_formats f on f.id=v.sale_format_id
  where not exists(select 1 from public.catalog_placements cp join public.catalog_tabs t on t.id=cp.tab_id
    where cp.product_id=v.product_id and coalesce(cp.variant_id,cp.default_variant_id)=v.id and t.key=f.key);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: sale format lacks exact final placement/tab representation: %',v_ids; end if;

  select string_agg(p.id::text, ', ' order by p.id) into v_ids from public.products p
  where p.is_active and p.product_type='menu' and not exists(
    select 1 from public.product_selection_group_assignments a
    join public.selection_groups g on g.id=a.group_id and g.kind='menu_component' and g.is_active
    where a.product_id=p.id and a.is_active and a.min_selection>0
      and exists(select 1 from public.selection_group_options o where o.group_id=g.id and o.is_active)
  ) and not exists(
    select 1 from public.product_variants v join public.variant_selection_groups x on x.variant_id=v.id
    join public.selection_groups g on g.id=x.selection_group_id and g.kind='menu_component' and g.is_active
    where v.product_id=p.id
  );
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: active menu lacks sufficient final or exactly convertible configuration: %',v_ids; end if;

  select string_agg(x.id::text, ', ' order by x.id) into v_ids from (
    select av.assignment_id::text||':'||av.variant_id::text id from public.product_selection_group_assignment_variants av
    left join public.product_selection_group_assignments a on a.id=av.assignment_id
    left join public.product_variants v on v.id=av.variant_id
    where a.id is null or v.id is null or av.product_id<>a.product_id or v.product_id<>a.product_id
      or av.tenant_id<>a.tenant_id or av.venue_id<>a.venue_id or v.tenant_id<>a.tenant_id or v.venue_id<>a.venue_id
    union all
    select av.assignment_id::text||':'||av.variant_id::text id from public.product_modifier_group_assignment_variants av
    left join public.product_modifier_group_assignments a on a.id=av.assignment_id
    left join public.product_variants v on v.id=av.variant_id
    where a.id is null or v.id is null or av.product_id<>a.product_id or v.product_id<>a.product_id
      or av.tenant_id<>a.tenant_id or av.venue_id<>a.venue_id or v.tenant_id<>a.tenant_id or v.venue_id<>a.venue_id
  ) x;
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: invalid final assignment variant scope: %',v_ids; end if;

  select format('%s on %s',co.conname,co.conrelid::regclass) into v_dependency
  from pg_constraint co
  where co.contype='f' and co.confrelid in(
    'public.sale_formats'::regclass,'public.selection_group_items'::regclass,
    'public.variant_selection_groups'::regclass,'public.product_modifier_groups'::regclass
  ) and co.conrelid not in(
    'public.sale_formats'::regclass,'public.selection_group_items'::regclass,
    'public.variant_selection_groups'::regclass,'public.product_modifier_groups'::regclass
  ) and co.conname<>'product_variants_sale_format_id_fkey' limit 1;
  if v_dependency is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: unexpected foreign-key dependency: %',v_dependency; end if;

  select format('%I.%I policy %I',schemaname,tablename,policyname) into v_dependency
  from pg_policies where schemaname='public'
    and coalesce(qual,'')||coalesce(with_check,'') ~ '(sale_formats|selection_group_items|variant_selection_groups|product_modifier_groups|default_variant_id|can_use_as_mixer|mixer_supplement_cents)'
    and policyname not in('categories_select','modifier_groups_select','modifiers_select',
      'selection_group_items_select','selection_group_items_admin_manage',
      'variant_selection_groups_select','variant_selection_groups_admin_manage',
      'product_modifier_groups_select','product_modifier_groups_admin_manage',
      'sale_formats_select','sale_formats_admin_manage') limit 1;
  if v_dependency is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: unexpected policy dependency: %',v_dependency; end if;

  select format('%s on %s',t.tgname,t.tgrelid::regclass) into v_dependency
  from pg_trigger t where not t.tgisinternal
    and pg_get_triggerdef(t.oid,true) ~ '(sale_formats|selection_group_items|variant_selection_groups|product_modifier_groups|default_variant_id|can_use_as_mixer|mixer_supplement_cents)'
    and t.tgname not in('validate_catalog_placements_relation','validate_selection_group_items_relation',
      'set_selection_group_items_updated_at','validate_variant_selection_groups_relation',
      'validate_product_modifier_groups_relation','set_sale_formats_updated_at') limit 1;
  if v_dependency is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: unexpected trigger dependency: %',v_dependency; end if;
  select p.oid::regprocedure::text into v_dependency
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f'
    and pg_get_functiondef(p.oid) ~ '(sale_formats|selection_group_items|variant_selection_groups|product_modifier_groups|default_variant_id|can_use_as_mixer|mixer_supplement_cents)'
    and p.proname not in('catalog_command','import_catalog','export_catalog','validate_final_catalog_scope',
      'capture_ticket_line_catalog_snapshot','validate_catalog_relation','canonical_catalog_component_modifiers',
      'save_restaurant_order_lines_v3','save_restaurant_order_lines','add_restaurant_order_line','add_restaurant_order_line_with_mixer')
  limit 1;
  if v_dependency is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: unexpected function dependency: %',v_dependency; end if;

  select format('%I.%I',n.nspname,c.relname) into v_dependency
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where c.relkind in('v','m') and n.nspname='public'
    and pg_get_viewdef(c.oid,true) ~ '(sale_formats|selection_group_items|variant_selection_groups|product_modifier_groups|default_variant_id|can_use_as_mixer|mixer_supplement_cents)'
  limit 1;
  if v_dependency is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: unexpected view dependency: %',v_dependency; end if;

  delete from public.order_lines l using public.orders o
  where o.id=l.order_id and o.status='open' and l.catalog_snapshot='{}'::jsonb;
  delete from public.ticket_lines l
  where trim(l.product_name)='' or l.unit_price_cents is null;
  delete from public.ticket_line_components c
  where trim(c.product_name_snapshot)='';

  if exists(select 1 from public.orders o join public.order_lines l on l.order_id=o.id where o.status='open' and l.catalog_snapshot='{}'::jsonb) then
    raise exception 'PHASE4_PREFLIGHT_FAILED: open order line lacks immutable catalog snapshot';
  end if;
  if exists(select 1 from public.ticket_lines l where trim(l.product_name)='' or l.unit_price_cents is null) then
    raise exception 'PHASE4_PREFLIGHT_FAILED: historical ticket line lacks product/price snapshot';
  end if;
  if exists(select 1 from public.ticket_line_components c where trim(c.product_name_snapshot)='') then
    raise exception 'PHASE4_PREFLIGHT_FAILED: historical component lacks name snapshot';
  end if;
end
$phase4_preflight$;

-- Residual data is copied only where the meaning is exact.
update public.catalog_placements set variant_id=default_variant_id
where variant_id is null and default_variant_id is not null;

insert into public.selection_group_options(
  id,tenant_id,venue_id,group_id,product_id,variant_id,supplement_cents,
  default_quantity,max_quantity,sort_order,is_active,created_at,updated_at)
select i.id,i.tenant_id,g.venue_id,i.group_id,i.product_id,i.variant_id,i.price_delta_cents,
  case when i.is_default then 1 else 0 end,null,i.sort_order,i.is_active,i.created_at,i.updated_at
from public.selection_group_items i join public.selection_groups g on g.id=i.group_id
on conflict(id) do nothing;

-- Active rows without any final catalogue role are residual source products,
-- not deployable final-domain entities. Exact legacy options were copied above,
-- so only products still lacking an active placement and active option are removed.
delete from public.products p
where p.is_active
  and not exists(
    select 1 from public.catalog_placements cp
    where cp.product_id=p.id and cp.is_active)
  and not exists(
    select 1 from public.selection_group_options o
    where o.product_id=p.id and o.is_active);

insert into public.product_selection_group_assignments(
  tenant_id,venue_id,product_id,group_id,min_selection,max_selection,applies_to_all_variants,sort_order,is_active)
select v.tenant_id,v.venue_id,v.product_id,g.id,g.min_select,g.max_select,false,min(x.sort_order),g.is_active
from public.variant_selection_groups x join public.product_variants v on v.id=x.variant_id
join public.selection_groups g on g.id=x.selection_group_id
group by v.tenant_id,v.venue_id,v.product_id,g.id,g.min_select,g.max_select,g.is_active
on conflict(product_id,group_id) do nothing;

insert into public.product_selection_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id)
select a.tenant_id,a.venue_id,a.id,a.product_id,x.variant_id
from public.variant_selection_groups x join public.product_variants v on v.id=x.variant_id
join public.product_selection_group_assignments a on a.product_id=v.product_id and a.group_id=x.selection_group_id
where not a.applies_to_all_variants on conflict do nothing;

insert into public.product_modifier_group_assignments(
  tenant_id,venue_id,product_id,group_id,min_selection,max_selection,applies_to_all_variants,sort_order,is_active)
select p.tenant_id,p.venue_id,x.product_id,x.modifier_group_id,g.min_select,g.max_select,
  bool_or(x.variant_id is null),min(x.sort_order),g.is_active
from public.product_modifier_groups x join public.products p on p.id=x.product_id
join public.modifier_groups g on g.id=x.modifier_group_id
group by p.tenant_id,p.venue_id,x.product_id,x.modifier_group_id,g.min_select,g.max_select,g.is_active
on conflict(product_id,group_id) do nothing;

insert into public.product_modifier_group_assignments(
  tenant_id,venue_id,product_id,group_id,min_selection,max_selection,applies_to_all_variants,sort_order,is_active)
select g.tenant_id,g.venue_id,g.product_id,g.id,g.min_select,g.max_select,true,g.sort_order,g.is_active
from public.modifier_groups g where g.product_id is not null on conflict(product_id,group_id) do nothing;

insert into public.product_modifier_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id)
select a.tenant_id,a.venue_id,a.id,a.product_id,x.variant_id
from public.product_modifier_groups x
join public.product_modifier_group_assignments a on a.product_id=x.product_id and a.group_id=x.modifier_group_id
where x.variant_id is not null and not a.applies_to_all_variants on conflict do nothing;

update public.modifiers set price_cents=supplement_cents where price_cents=0 and supplement_cents<>0;

do $phase4_residual$
declare v_ids text;
begin
  select string_agg(i.id::text,', ' order by i.id) into v_ids from public.selection_group_items i
  where not exists(select 1 from public.selection_group_options o where o.id=i.id and o.group_id=i.group_id
    and o.product_id=i.product_id and o.variant_id is not distinct from i.variant_id
    and o.supplement_cents=i.price_delta_cents and o.default_quantity=case when i.is_default then 1 else 0 end);
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: selection item residual mismatch: %',v_ids; end if;

  select string_agg(x.variant_id::text,', ' order by x.variant_id) into v_ids
  from public.variant_selection_groups x join public.product_variants v on v.id=x.variant_id
  where not exists(select 1 from public.product_selection_group_assignments a
    where a.product_id=v.product_id and a.group_id=x.selection_group_id
      and (a.applies_to_all_variants or exists(select 1 from public.product_selection_group_assignment_variants av where av.assignment_id=a.id and av.variant_id=x.variant_id)));
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: selection assignment residual mismatch: %',v_ids; end if;

  select string_agg(x.product_id::text,', ' order by x.product_id) into v_ids
  from public.product_modifier_groups x
  where not exists(select 1 from public.product_modifier_group_assignments a
    where a.product_id=x.product_id and a.group_id=x.modifier_group_id
      and (x.variant_id is null and a.applies_to_all_variants or x.variant_id is not null
        and (a.applies_to_all_variants or exists(select 1 from public.product_modifier_group_assignment_variants av where av.assignment_id=a.id and av.variant_id=x.variant_id))));
  if v_ids is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: modifier assignment residual mismatch: %',v_ids; end if;
  if exists(select 1 from public.modifiers where price_cents<>supplement_cents) then
    raise exception 'PHASE4_PREFLIGHT_FAILED: modifier supplement conversion mismatch';
  end if;
end
$phase4_residual$;

-- Flush deferred catalogue guards created by residual inserts/deletes before
-- any ALTER TABLE; PostgreSQL rejects DDL while those trigger events are pending.
set constraints all immediate;


create or replace function public.catalog_command(p_venue_id uuid, p_command text, p_payload jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_id uuid;
  v_product_id uuid;
  v_group_id uuid;
  v_variant_id uuid;
  v_item jsonb;
  v_table text;
  v_path text;
  v_orphaned_paths text[] := '{}';
  v_default_count integer;
  v_default_assigned boolean := false;
begin
  select v.tenant_id into v_tenant_id from public.venues v where v.id = p_venue_id for update;
  if v_tenant_id is null then raise exception 'CATALOG_VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant_id) then
    raise exception 'CATALOG_COMMAND_FORBIDDEN';
  end if;

  if p_command = 'create_product' then
    if jsonb_typeof(p_payload -> 'variants') <> 'array' or jsonb_array_length(p_payload -> 'variants') = 0 then
      raise exception 'CATALOG_PRODUCT_REQUIRES_VARIANT';
    end if;
    select count(*) into v_default_count from jsonb_array_elements(p_payload -> 'variants') x
      where coalesce((x ->> 'active')::boolean, true) and coalesce((x ->> 'isDefault')::boolean, false);
    if v_default_count > 1 then raise exception 'INVALID_ACTIVE_DEFAULT_VARIANT_COUNT'; end if;
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.products(id, tenant_id, venue_id, name, description, product_type, tax_rate, is_active, sort_order)
    values (v_id, v_tenant_id, p_venue_id, trim(p_payload ->> 'name'), nullif(p_payload ->> 'description', ''),
      p_payload ->> 'type', nullif(p_payload ->> 'vatRate', '')::numeric,
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer);
    for v_item in select value from jsonb_array_elements(p_payload -> 'variants') loop
      if v_default_count = 0 and not v_default_assigned and coalesce((v_item ->> 'active')::boolean, true) then
        v_item := jsonb_set(v_item, '{isDefault}', 'true'::jsonb);
        v_default_assigned := true;
      end if;
      v_variant_id := coalesce(nullif(v_item ->> 'id', '')::uuid, gen_random_uuid());
      insert into public.product_variants(id, tenant_id, venue_id, product_id, name, price_cents, sku,
        is_default, is_active, sort_order)
      values (v_variant_id, v_tenant_id, p_venue_id, v_id, trim(v_item ->> 'name'),
        (v_item ->> 'priceCents')::integer, nullif(v_item ->> 'sku', ''),
        coalesce((v_item ->> 'isDefault')::boolean, false),
        coalesce((v_item ->> 'active')::boolean, true), (v_item ->> 'sortOrder')::integer);
    end loop;

  elsif p_command = 'update_product' then
    v_id := (p_payload ->> 'id')::uuid;
    if p_payload ? 'active' and not (p_payload ->> 'active')::boolean then
      update public.product_selection_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
      update public.product_modifier_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
    end if;
    update public.products p set
      name = case when p_payload ? 'name' then trim(p_payload ->> 'name') else p.name end,
      description = case when p_payload ? 'description' then nullif(p_payload ->> 'description', '') else p.description end,
      product_type = case when p_payload ? 'type' then p_payload ->> 'type' else p.product_type end,
      tax_rate = case when p_payload ? 'vatRate' then nullif(p_payload ->> 'vatRate', '')::numeric else p.tax_rate end,
      is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else p.is_active end,
      sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else p.sort_order end
    where p.id = v_id and p.venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;

  elsif p_command = 'set_product_active' then
    v_id := (p_payload ->> 'id')::uuid;
    if not (p_payload ->> 'active')::boolean then
      update public.product_selection_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
      update public.product_modifier_group_assignments set is_active = false where product_id = v_id and venue_id = p_venue_id;
    end if;
    update public.products set is_active = (p_payload ->> 'active')::boolean where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;

  elsif p_command = 'delete_product' then
    v_id := (p_payload ->> 'id')::uuid;
    select i.storage_path into v_path from public.product_images i where i.product_id = v_id and i.venue_id = p_venue_id;
    delete from public.products where id = v_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PRODUCT_NOT_FOUND'; end if;
    if v_path is not null and not exists (select 1 from public.product_images where storage_path = v_path) then
      v_orphaned_paths := array_append(v_orphaned_paths, v_path);
    end if;

  elsif p_command in ('create_variant', 'update_variant') then
    v_product_id := (p_payload ->> 'productId')::uuid;
    if not exists (select 1 from public.products where id = v_product_id and venue_id = p_venue_id) then
      raise exception 'CATALOG_PRODUCT_NOT_FOUND';
    end if;
    v_id := case when p_command = 'update_variant' then (p_payload ->> 'id')::uuid
      else coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid()) end;
    if coalesce((p_payload ->> 'isDefault')::boolean, false) then
      update public.product_variants set is_default = false where product_id = v_product_id and venue_id = p_venue_id;
    end if;
    if p_command = 'create_variant' then
      insert into public.product_variants(id, tenant_id, venue_id, product_id, name, price_cents, sku,
        is_default, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, trim(p_payload ->> 'name'),
        (p_payload ->> 'priceCents')::integer, nullif(p_payload ->> 'sku', ''),
        coalesce((p_payload ->> 'isDefault')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer);
    else
      update public.product_variants v set
        name = case when p_payload ? 'name' then trim(p_payload ->> 'name') else v.name end,
        price_cents = case when p_payload ? 'priceCents' then (p_payload ->> 'priceCents')::integer else v.price_cents end,
        sku = case when p_payload ? 'sku' then nullif(p_payload ->> 'sku', '') else v.sku end,
        is_default = case when p_payload ? 'isDefault' then (p_payload ->> 'isDefault')::boolean else v.is_default end,
        is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else v.is_active end,
        sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else v.sort_order end
      where v.id = v_id and v.product_id = v_product_id and v.venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;
    end if;

  elsif p_command = 'set_default_variant' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_variant_id := (p_payload ->> 'variantId')::uuid;
    if not exists (select 1 from public.product_variants where id = v_variant_id and product_id = v_product_id and venue_id = p_venue_id and is_active) then
      raise exception 'CATALOG_VARIANT_PRODUCT_MISMATCH';
    end if;
    update public.product_variants set is_default = (id = v_variant_id)
      where product_id = v_product_id and venue_id = p_venue_id;

  elsif p_command = 'delete_variant' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_id := (p_payload ->> 'id')::uuid;
    if exists (select 1 from public.product_variants where id = v_id and product_id = v_product_id and venue_id = p_venue_id and is_active and is_default) then
      raise exception 'CATALOG_DEFAULT_VARIANT_REQUIRES_REPLACEMENT';
    end if;
    delete from public.product_variants where id = v_id and product_id = v_product_id and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_VARIANT_NOT_FOUND'; end if;

  elsif p_command in ('create_placement', 'update_placement') then
    v_id := case when p_command = 'update_placement' then (p_payload ->> 'id')::uuid
      else coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid()) end;
    if p_command = 'create_placement' then
      insert into public.catalog_placements(id, tenant_id, venue_id, product_id, tab_id, category_id, variant_id,
        is_featured, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'productId')::uuid, (p_payload ->> 'tabId')::uuid,
        nullif(p_payload ->> 'categoryId', '')::uuid, nullif(p_payload ->> 'pinnedVariantId', '')::uuid,
        coalesce((p_payload ->> 'featured')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer);
    else
      update public.catalog_placements cp set
        product_id = case when p_payload ? 'productId' then (p_payload ->> 'productId')::uuid else cp.product_id end,
        tab_id = case when p_payload ? 'tabId' then (p_payload ->> 'tabId')::uuid else cp.tab_id end,
        category_id = case when p_payload ? 'categoryId' then nullif(p_payload ->> 'categoryId', '')::uuid else cp.category_id end,
        variant_id = case when p_payload ? 'pinnedVariantId' then nullif(p_payload ->> 'pinnedVariantId', '')::uuid else cp.variant_id end,
        is_featured = case when p_payload ? 'featured' then (p_payload ->> 'featured')::boolean else cp.is_featured end,
        is_active = case when p_payload ? 'active' then (p_payload ->> 'active')::boolean else cp.is_active end,
        sort_order = case when p_payload ? 'sortOrder' then (p_payload ->> 'sortOrder')::integer else cp.sort_order end
      where cp.id = v_id and cp.venue_id = p_venue_id;
      if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;
    end if;

  elsif p_command = 'delete_placement' then
    delete from public.catalog_placements where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;

  elsif p_command = 'save_tab' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.catalog_tabs(id, tenant_id, venue_id, key, label, icon, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, p_payload ->> 'key', trim(p_payload ->> 'label'), nullif(p_payload ->> 'icon', ''),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set key = excluded.key, label = excluded.label, icon = excluded.icon,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where catalog_tabs.venue_id = p_venue_id;

  elsif p_command = 'delete_tab' then
    delete from public.catalog_tabs where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_PLACEMENT_INVALID'; end if;

  elsif p_command = 'save_category' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.categories(id, tenant_id, venue_id, name, icon, unused, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, trim(p_payload ->> 'name'), nullif(p_payload ->> 'icon', ''),
      coalesce((p_payload ->> 'unused')::boolean, false), coalesce((p_payload ->> 'active')::boolean, true),
      (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set name = excluded.name, icon = excluded.icon, unused = excluded.unused,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where categories.venue_id = p_venue_id;

  elsif p_command = 'delete_category' then
    delete from public.categories where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_selection_group' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.selection_groups(id, tenant_id, venue_id, kind, name, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, p_payload ->> 'type', trim(p_payload ->> 'name'),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set kind = excluded.kind, name = excluded.name,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where selection_groups.venue_id = p_venue_id;

  elsif p_command = 'delete_selection_group' then
    delete from public.selection_groups where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_selection_option' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.selection_group_options(id, tenant_id, venue_id, group_id, product_id, variant_id,
      supplement_cents, default_quantity, max_quantity, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'groupId')::uuid, (p_payload ->> 'productId')::uuid,
      nullif(p_payload ->> 'variantId', '')::uuid, (p_payload ->> 'supplementCents')::integer,
      (p_payload ->> 'defaultQuantity')::integer, nullif(p_payload ->> 'maxQuantity', '')::integer,
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set group_id = excluded.group_id, product_id = excluded.product_id,
      variant_id = excluded.variant_id, supplement_cents = excluded.supplement_cents,
      default_quantity = excluded.default_quantity, max_quantity = excluded.max_quantity,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where selection_group_options.venue_id = p_venue_id;

  elsif p_command = 'delete_selection_option' then
    delete from public.selection_group_options where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_modifier_group' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.modifier_groups(id, tenant_id, venue_id, name, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, trim(p_payload ->> 'name'),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set name = excluded.name,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where modifier_groups.venue_id = p_venue_id;

  elsif p_command = 'delete_modifier_group' then
    delete from public.modifier_groups where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_modifier' then
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    insert into public.modifiers(id, tenant_id, venue_id, group_id, name, supplement_cents,
      is_default, is_active, sort_order)
    values(v_id, v_tenant_id, p_venue_id, (p_payload ->> 'groupId')::uuid, trim(p_payload ->> 'name'),
      (p_payload ->> 'supplementCents')::integer, coalesce((p_payload ->> 'isDefault')::boolean, false),
      coalesce((p_payload ->> 'active')::boolean, true), (p_payload ->> 'sortOrder')::integer)
    on conflict (id) do update set group_id = excluded.group_id, name = excluded.name,
      supplement_cents = excluded.supplement_cents, is_default = excluded.is_default,
      is_active = excluded.is_active, sort_order = excluded.sort_order
    where modifiers.venue_id = p_venue_id;

  elsif p_command = 'delete_modifier' then
    delete from public.modifiers where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'save_assignment' then
    v_product_id := (p_payload ->> 'productId')::uuid;
    v_group_id := (p_payload ->> 'groupId')::uuid;
    v_id := coalesce(nullif(p_payload ->> 'id', '')::uuid, gen_random_uuid());
    if p_payload ->> 'domain' = 'selection' then
      insert into public.product_selection_group_assignments(id, tenant_id, venue_id, product_id, group_id,
        display_name, min_selection, max_selection, applies_to_all_variants, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, v_group_id, nullif(p_payload ->> 'displayName', ''),
        (p_payload ->> 'minSelection')::integer, (p_payload ->> 'maxSelection')::integer,
        (p_payload ->> 'appliesToAllVariants')::boolean, coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer)
      on conflict (product_id, group_id) do update set display_name = excluded.display_name,
        min_selection = excluded.min_selection, max_selection = excluded.max_selection,
        applies_to_all_variants = excluded.applies_to_all_variants, is_active = excluded.is_active,
        sort_order = excluded.sort_order returning id into v_id;
      delete from public.product_selection_group_assignment_variants where assignment_id = v_id;
      if not (p_payload ->> 'appliesToAllVariants')::boolean then
        for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'variantIds', '[]'::jsonb)) loop
          insert into public.product_selection_group_assignment_variants(tenant_id, venue_id, assignment_id, product_id, variant_id)
          values(v_tenant_id, p_venue_id, v_id, v_product_id, (v_item #>> '{}')::uuid);
        end loop;
      end if;
    elsif p_payload ->> 'domain' = 'modifier' then
      insert into public.product_modifier_group_assignments(id, tenant_id, venue_id, product_id, group_id,
        display_name, min_selection, max_selection, applies_to_all_variants, is_active, sort_order)
      values(v_id, v_tenant_id, p_venue_id, v_product_id, v_group_id, nullif(p_payload ->> 'displayName', ''),
        (p_payload ->> 'minSelection')::integer, (p_payload ->> 'maxSelection')::integer,
        (p_payload ->> 'appliesToAllVariants')::boolean, coalesce((p_payload ->> 'active')::boolean, true),
        (p_payload ->> 'sortOrder')::integer)
      on conflict (product_id, group_id) do update set display_name = excluded.display_name,
        min_selection = excluded.min_selection, max_selection = excluded.max_selection,
        applies_to_all_variants = excluded.applies_to_all_variants, is_active = excluded.is_active,
        sort_order = excluded.sort_order returning id into v_id;
      delete from public.product_modifier_group_assignment_variants where assignment_id = v_id;
      if not (p_payload ->> 'appliesToAllVariants')::boolean then
        for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'variantIds', '[]'::jsonb)) loop
          insert into public.product_modifier_group_assignment_variants(tenant_id, venue_id, assignment_id, product_id, variant_id)
          values(v_tenant_id, p_venue_id, v_id, v_product_id, (v_item #>> '{}')::uuid);
        end loop;
      end if;
    else raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'delete_assignment' then
    if p_payload ->> 'domain' = 'selection' then
      delete from public.product_selection_group_assignments where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    elsif p_payload ->> 'domain' = 'modifier' then
      delete from public.product_modifier_group_assignments where id = (p_payload ->> 'id')::uuid and venue_id = p_venue_id;
    else raise exception 'CATALOG_GROUP_INVALID'; end if;
    if not found then raise exception 'CATALOG_GROUP_INVALID'; end if;

  elsif p_command = 'reorder' then
    v_table := case p_payload ->> 'entity'
      when 'products' then 'products' when 'variants' then 'product_variants'
      when 'placements' then 'catalog_placements' when 'tabs' then 'catalog_tabs'
      when 'categories' then 'categories' when 'tab_categories' then 'catalog_tab_categories'
      when 'selection_groups' then 'selection_groups' when 'selection_options' then 'selection_group_options'
      when 'selection_assignments' then 'product_selection_group_assignments'
      when 'modifier_groups' then 'modifier_groups' when 'modifiers' then 'modifiers'
      when 'modifier_assignments' then 'product_modifier_group_assignments' else null end;
    if v_table is null then raise exception 'CATALOG_INVALID_REORDER_ENTITY'; end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) order by value ->> 'id' loop
      execute format('update public.%I set sort_order = $1 where id = $2 and venue_id = $3', v_table)
        using (v_item ->> 'sortOrder')::integer, (v_item ->> 'id')::uuid, p_venue_id;
      if not found then raise exception 'CATALOG_REORDER_ENTITY_NOT_FOUND'; end if;
    end loop;
  else
    raise exception 'CATALOG_UNKNOWN_COMMAND %', p_command;
  end if;

  set constraints all immediate;
  return jsonb_build_object('result', 'SUCCESS', 'id', v_id, 'orphanedImagePaths', to_jsonb(v_orphaned_paths));
end;
$$;


create or replace function public.canonical_catalog_modifiers(
  p_venue_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_submitted jsonb
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'groupId', g.id, 'name', m.name, 'priceCents', m.supplement_cents
  ) order by a.sort_order, g.sort_order, m.sort_order, m.id), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_submitted, '[]'::jsonb)) submitted
  join public.modifiers m on m.id = nullif(submitted ->> 'id', '')::uuid
    and m.venue_id = p_venue_id and m.is_active
  join public.modifier_groups g on g.id = m.group_id and g.venue_id = p_venue_id and g.is_active
  join public.product_modifier_group_assignments a on a.group_id = g.id
    and a.product_id = p_product_id and a.venue_id = p_venue_id and a.is_active
    and (a.applies_to_all_variants or exists (
      select 1 from public.product_modifier_group_assignment_variants av
      where av.assignment_id = a.id and av.variant_id = p_variant_id
    ));
$$;


create or replace function public.persist_catalog_order_line_draft(
  p_order_id uuid,p_expected_revision integer,p_lines jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  o public.orders%rowtype; item jsonb; current_line public.order_lines%rowtype;
  line_id uuid; selected_product_id uuid; selected_variant_id uuid; quantity_value integer; note_value text;
  retained uuid[]:='{}'; signatures text[]:='{}'; signature text; next_revision integer;
  selected_product_name text; selected_variant_name text; base_price integer;
begin
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)>500 then
    raise exception 'CATALOG_LINES_MUST_BE_ARRAY';
  end if;
  select * into o from public.orders where id=p_order_id for update;
  if o.id is null or o.status<>'open' or not public.user_has_venue_access(o.tenant_id,o.venue_id) then
    raise exception 'CATALOG_ORDER_NOT_FOUND' using errcode='42501';
  end if;
  if o.revision<>p_expected_revision then raise exception 'CATALOG_ORDER_REVISION_CONFLICT' using errcode='40001'; end if;
  perform 1 from public.order_lines l where l.order_id=o.id order by l.id for update;

  for item in select value from jsonb_array_elements(p_lines) loop
    line_id:=(item->>'id')::uuid;
    quantity_value:=(item->>'quantity')::integer;
    note_value:=nullif(trim(item->>'note'),'');
    if quantity_value<1 or quantity_value>9999 or line_id=any(retained) then raise exception 'CATALOG_INVALID_ORDER_DRAFT'; end if;
    select * into current_line from public.order_lines where id=line_id and order_id=o.id;
    if current_line.id is not null and current_line.served_quantity>0 then
      if quantity_value<current_line.served_quantity
        or nullif(item->>'productId','')::uuid is distinct from current_line.product_id
        or nullif(item->>'variantId','')::uuid is distinct from current_line.variant_id then
        raise exception 'CATALOG_SERVED_LINE_IMMUTABLE';
      end if;
      update public.order_lines set quantity=quantity_value,note=note_value,
        fully_served_at=case when quantity_value=served_quantity then coalesce(fully_served_at,now()) else null end
      where id=line_id;
      retained:=array_append(retained,line_id);
      continue;
    end if;

    selected_product_id:=nullif(item->>'productId','')::uuid;
    selected_variant_id:=nullif(item->>'variantId','')::uuid;
    select p.name,v.name,v.price_cents into selected_product_name,selected_variant_name,base_price
    from public.products p join public.product_variants v on v.product_id=p.id
    where p.id=selected_product_id and v.id=selected_variant_id
      and p.tenant_id=o.tenant_id and p.venue_id=o.venue_id
      and v.tenant_id=o.tenant_id and v.venue_id=o.venue_id and p.is_active and v.is_active;
    if base_price is null then raise exception 'CATALOG_PRODUCT_NOT_SELLABLE'; end if;
    signature:=concat_ws('|',selected_product_id,selected_variant_id,coalesce(item->'modifierIds','[]'::jsonb),coalesce(item->'components','[]'::jsonb),coalesce(note_value,''));
    if signature=any(signatures) then raise exception 'CATALOG_DUPLICATE_ORDER_LINE'; end if;
    signatures:=array_append(signatures,signature);

    if current_line.id is null then
      insert into public.order_lines(
        id,tenant_id,venue_id,order_id,product_id,variant_id,product_name,variant_name,
        unit_price_cents,quantity,modifiers,components,catalog_snapshot,mixer_product_id,mixer,note)
      values(line_id,o.tenant_id,o.venue_id,o.id,selected_product_id,selected_variant_id,
        selected_product_name,selected_variant_name,base_price,quantity_value,'[]','[]',
        coalesce(item->'catalogSnapshot','{}'),null,null,note_value);
    else
      update public.order_lines set product_id=selected_product_id,variant_id=selected_variant_id,
        product_name=selected_product_name,variant_name=selected_variant_name,unit_price_cents=base_price,
        quantity=quantity_value,modifiers='[]',components='[]',catalog_snapshot=coalesce(item->'catalogSnapshot','{}'),
        mixer_product_id=null,mixer=null,note=note_value,fully_served_at=null
      where id=line_id;
    end if;
    retained:=array_append(retained,line_id);
  end loop;

  if exists(select 1 from public.order_lines where order_id=o.id and not(id=any(retained)) and served_quantity>0) then
    raise exception 'CATALOG_SERVED_LINE_DELETE_FORBIDDEN';
  end if;
  delete from public.order_lines where order_id=o.id and not(id=any(retained));
  update public.orders set revision=revision+1 where id=o.id returning revision into next_revision;
  return jsonb_build_object('revision',next_revision);
end $$;

revoke all on function public.persist_catalog_order_line_draft(uuid,integer,jsonb) from public,anon,authenticated;


create or replace function public.save_catalog_order_lines(
  p_order_id uuid,
  p_expected_revision integer,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_base_lines jsonb;
  v_result_lines jsonb;
  v_line jsonb;
  v_line_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
  v_venue_id uuid;
  v_base_price integer;
  v_unit_price integer;
  v_sent_count integer;
  v_component_count integer;
  v_line_modifiers jsonb;
  v_submitted_modifiers jsonb;
  v_components jsonb;
begin
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'CATALOG_LINES_MUST_BE_ARRAY'; end if;
  select o.venue_id into v_venue_id from public.orders o where o.id = p_order_id;
  if v_venue_id is null then raise exception 'CATALOG_ORDER_NOT_FOUND'; end if;

  -- The proven order/revision/served-line implementation creates the rows. New
  -- catalogue selections are canonicalised below, so transitional modifier and
  -- mixer inputs are deliberately removed before calling it.
  select coalesce(jsonb_agg(value || jsonb_build_object(
    'modifierIds', '[]'::jsonb, 'mixerProductId', null, 'mixer', null
  )), '[]'::jsonb) into v_base_lines from jsonb_array_elements(p_lines);
  v_result := public.persist_catalog_order_line_draft(p_order_id, p_expected_revision, v_base_lines);

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_id := (v_line ->> 'id')::uuid;
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

    update public.order_lines ol set
      modifiers = v_line_modifiers,
      components = v_components,
      mixer_product_id = null,
      mixer = null,
      catalog_snapshot = coalesce(v_line -> 'catalogSnapshot', '{}'::jsonb),
      unit_price_cents = v_unit_price
    where ol.id = v_line_id and ol.order_id = p_order_id;
    if not found then raise exception 'CATALOG_ORDER_LINE_NOT_FOUND'; end if;

    delete from public.order_line_components where order_line_id = v_line_id;
    insert into public.order_line_components(
      tenant_id, venue_id, order_line_id, component_type, selection_group_id,
      product_id, variant_id, product_name_snapshot, variant_name_snapshot,
      quantity, price_delta_cents, sort_order, metadata
    )
    select ol.tenant_id, ol.venue_id, ol.id, c.type, nullif(c."selectionGroupId", '')::uuid,
      nullif(c."productId", '')::uuid, nullif(c."variantId", '')::uuid,
      c."productName", c."variantName", c.quantity, c."priceDeltaCents", c."sortOrder",
      jsonb_build_object('modifiers', coalesce(c.modifiers, '[]'::jsonb))
    from public.order_lines ol
    cross join jsonb_to_recordset(v_components) c(
      type text, "selectionGroupId" text, "productId" text, "variantId" text,
      "productName" text, "variantName" text, quantity integer,
      "priceDeltaCents" integer, "sortOrder" integer, modifiers jsonb
    )
    where ol.id = v_line_id;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ol.id, 'tenantId', ol.tenant_id, 'venueId', ol.venue_id, 'orderId', ol.order_id,
    'productId', ol.product_id, 'variantId', ol.variant_id, 'productName', ol.product_name,
    'variantName', ol.variant_name, 'unitPriceCents', ol.unit_price_cents, 'quantity', ol.quantity,
    'servedQuantity', ol.served_quantity, 'fullyServedAt', ol.fully_served_at,
    'modifiers', ol.modifiers, 'components', ol.components, 'catalogSnapshot', ol.catalog_snapshot,
    'mixerProductId', ol.mixer_product_id, 'mixer', ol.mixer, 'note', ol.note,
    'createdAt', ol.created_at, 'updatedAt', ol.updated_at
  ) order by ol.created_at, ol.id), '[]'::jsonb)
  into v_result_lines from public.order_lines ol where ol.order_id = p_order_id;

  return jsonb_build_object('revision', (v_result ->> 'revision')::integer, 'lines', v_result_lines);
end;
$$;


create or replace function public.capture_ticket_line_catalog_snapshot()
returns trigger language plpgsql security definer set search_path='' as $$
declare line_payload jsonb; snapshot_payload jsonb;
begin
  select line into line_payload from public.offline_event_log e
  cross join lateral jsonb_array_elements(e.payload->'lines') line
  where e.tenant_id=new.tenant_id and e.payload->'ticket'->>'id'=new.ticket_id::text and line->>'id'=new.id::text
  order by e.created_at desc limit 1;
  snapshot_payload:=line_payload->'catalogSnapshot';
  if snapshot_payload is null then
    select (array_agg(l.catalog_snapshot order by l.updated_at desc))[1] into snapshot_payload
    from public.order_lines l join public.orders o on o.id=l.order_id join public.tickets t on t.id=new.ticket_id
    where l.tenant_id=new.tenant_id and o.cash_session_id=t.cash_session_id and o.venue_id=t.venue_id
      and l.product_id is not distinct from new.product_id and l.variant_id is not distinct from new.variant_id
      and l.unit_price_cents=new.unit_price_cents and l.catalog_snapshot<>'{}'::jsonb having count(*)=1;
  end if;
  if snapshot_payload is not null then
    new.category_id_snapshot:=nullif(snapshot_payload->>'categoryId','')::uuid;
    new.category_name_snapshot:=nullif(snapshot_payload->>'categoryName','');
    new.catalog_tab_id_snapshot:=nullif(snapshot_payload->>'catalogTabId','')::uuid;
    new.catalog_tab_name_snapshot:=nullif(snapshot_payload->>'catalogTabName','');
  end if;
  new.base_price_cents:=coalesce(nullif(line_payload->>'basePriceCents','')::integer,new.unit_price_cents);
  new.component_delta_cents:=coalesce(nullif(line_payload->>'componentDeltaCents','')::integer,0);
  new.modifier_delta_cents:=coalesce(nullif(line_payload->>'modifierDeltaCents','')::integer,0);
  new.gross_before_discount_cents:=coalesce(nullif(line_payload->>'grossBeforeDiscountCents','')::integer,new.unit_price_cents);
  return new;
end $$;

create or replace function public.validate_final_catalog_scope()
returns trigger language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from public.venues v where v.id=new.venue_id and v.tenant_id=new.tenant_id) then
    raise exception 'CATALOG_SCOPE_MISMATCH';
  end if;
  if tg_table_name='product_variants' then
    if not exists(
      select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id
    ) then raise exception 'VARIANT_PRODUCT_SCOPE_MISMATCH'; end if;
  elsif tg_table_name='catalog_placements' then
    if not exists(select 1 from public.products p where p.id=new.product_id and p.tenant_id=new.tenant_id and p.venue_id=new.venue_id) then raise exception 'PLACEMENT_PRODUCT_SCOPE_MISMATCH'; end if;
    if not exists(select 1 from public.catalog_tabs t where t.id=new.tab_id and t.tenant_id=new.tenant_id and t.venue_id=new.venue_id) then raise exception 'PLACEMENT_TAB_SCOPE_MISMATCH'; end if;
    if new.category_id is not null and not exists(select 1 from public.categories c where c.id=new.category_id and c.tenant_id=new.tenant_id and c.venue_id=new.venue_id) then raise exception 'PLACEMENT_CATEGORY_SCOPE_MISMATCH'; end if;
    if new.variant_id is not null and not exists(select 1 from public.product_variants v where v.id=new.variant_id and v.product_id=new.product_id and v.tenant_id=new.tenant_id and v.venue_id=new.venue_id) then raise exception 'PLACEMENT_VARIANT_PRODUCT_MISMATCH'; end if;
  elsif tg_table_name='modifiers' then
    if not exists(
      select 1 from public.modifier_groups g where g.id=new.group_id and g.tenant_id=new.tenant_id and g.venue_id=new.venue_id
    ) then raise exception 'MODIFIER_GROUP_SCOPE_MISMATCH'; end if;
  end if;
  return new;
end $$;


create or replace function public.import_catalog(p_venue_id uuid, p_mode text, p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid; v_item jsonb; v_ref text; v_product uuid; v_assignment uuid; v_variant_ref text;
  v_existing bigint; v_removed_paths text[] := '{}';
begin
  if p_mode not in ('empty', 'replace') then raise exception 'INVALID_IMPORT_MODE'; end if;
  select tenant_id into v_tenant from public.venues where id = p_venue_id for update;
  if v_tenant is null then raise exception 'VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_tenant) then raise exception 'CATALOG_IMPORT_FORBIDDEN'; end if;
  if p_plan->>'venueId' <> p_venue_id::text then raise exception 'PLAN_VENUE_MISMATCH'; end if;
  select (select count(*) from public.products where venue_id=p_venue_id) + (select count(*) from public.catalog_tabs where venue_id=p_venue_id) + (select count(*) from public.categories where venue_id=p_venue_id) into v_existing;
  if p_mode = 'empty' and v_existing > 0 then raise exception 'CATALOG_NOT_EMPTY'; end if;
  if p_mode = 'replace' then
    select coalesce(array_agg(storage_path), '{}') into v_removed_paths from public.product_images where venue_id=p_venue_id;
    delete from public.products where venue_id=p_venue_id;
    delete from public.catalog_tabs where venue_id=p_venue_id;
    delete from public.selection_groups where venue_id=p_venue_id;
    delete from public.modifier_groups where venue_id=p_venue_id;
    delete from public.categories where venue_id=p_venue_id;
  end if;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,categories}') loop
    v_ref:=v_item->>'ref'; insert into public.categories(id,tenant_id,venue_id,name,icon,sort_order,is_active,unused) values ((p_plan->'generatedIds'->'categories'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',v_item->>'icon',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean,(v_item->>'unused')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,tabs}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_tabs(id,tenant_id,venue_id,key,label,icon,sort_order,is_active) values ((p_plan->'generatedIds'->'tabs'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'key',v_item->>'label',coalesce(v_item->>'icon','receipt'),(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,products}') loop
    v_ref:=v_item->>'ref'; insert into public.products(id,tenant_id,venue_id,name,description,product_type,tax_rate,is_active,sort_order) values ((p_plan->'generatedIds'->'products'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',v_item->>'description',v_item->>'type',nullif(v_item->>'taxRate','')::numeric,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,variants}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid;
    insert into public.product_variants(id,tenant_id,venue_id,product_id,name,price_cents,sku,is_default,is_active,sort_order) values ((p_plan->'generatedIds'->'variants'->>v_ref)::uuid,v_tenant,p_venue_id,v_product,v_item->>'name',(v_item->>'priceCents')::integer,v_item->>'sku',(v_item->>'isDefault')::boolean,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,images}') where not (value->>'missing')::boolean loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid;
    insert into public.product_images(id,tenant_id,venue_id,product_id,storage_path,mime_type,size_bytes,sha256) values ((p_plan->'generatedIds'->'images'->>v_ref)::uuid,v_tenant,p_venue_id,v_product,p_plan->'imagePaths'->>v_ref,v_item->>'mimeType',(v_item->>'sizeBytes')::bigint,v_item->>'sha256');
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,tabCategories}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_tab_categories(id,tenant_id,venue_id,tab_id,category_id,sort_order,is_active) values ((p_plan->'generatedIds'->'tabCategories'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'tabs'->>(v_item->>'tabRef'))::uuid,(p_plan->'generatedIds'->'categories'->>(v_item->>'categoryRef'))::uuid,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,placements}') loop
    v_ref:=v_item->>'ref'; insert into public.catalog_placements(id,tenant_id,venue_id,tab_id,category_id,product_id,variant_id,is_featured,sort_order,is_active) values ((p_plan->'generatedIds'->'placements'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'tabs'->>(v_item->>'tabRef'))::uuid,(p_plan->'generatedIds'->'categories'->>(v_item->>'categoryRef'))::uuid,(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid,(p_plan->'generatedIds'->'variants'->>(v_item->>'variantRef'))::uuid,(v_item->>'featured')::boolean,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionGroups}') loop
    v_ref:=v_item->>'ref'; insert into public.selection_groups(id,tenant_id,venue_id,kind,name,sort_order,is_active) values ((p_plan->'generatedIds'->'selectionGroups'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'type',v_item->>'name',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionGroupOptions}') loop
    v_ref:=v_item->>'ref'; insert into public.selection_group_options(id,tenant_id,venue_id,group_id,product_id,variant_id,supplement_cents,default_quantity,max_quantity,sort_order,is_active) values ((p_plan->'generatedIds'->'selectionGroupOptions'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'selectionGroups'->>(v_item->>'groupRef'))::uuid,(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid,(p_plan->'generatedIds'->'variants'->>(v_item->>'variantRef'))::uuid,(v_item->>'supplementCents')::integer,(v_item->>'defaultQuantity')::integer,nullif(v_item->>'maxQuantity','')::integer,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,selectionAssignments}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid; v_assignment:=(p_plan->'generatedIds'->'selectionAssignments'->>v_ref)::uuid;
    insert into public.product_selection_group_assignments(id,tenant_id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active) values (v_assignment,v_tenant,p_venue_id,v_product,(p_plan->'generatedIds'->'selectionGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'displayName',(v_item->>'minSelection')::integer,(v_item->>'maxSelection')::integer,jsonb_array_length(v_item->'variantRefs')=0,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
    for v_variant_ref in select jsonb_array_elements_text(v_item->'variantRefs') loop insert into public.product_selection_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id) values(v_tenant,p_venue_id,v_assignment,v_product,(p_plan->'generatedIds'->'variants'->>v_variant_ref)::uuid); end loop;
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifierGroups}') loop
    v_ref:=v_item->>'ref'; insert into public.modifier_groups(id,tenant_id,venue_id,name,sort_order,is_active) values ((p_plan->'generatedIds'->'modifierGroups'->>v_ref)::uuid,v_tenant,p_venue_id,v_item->>'name',(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifiers}') loop
    v_ref:=v_item->>'ref'; insert into public.modifiers(id,tenant_id,venue_id,group_id,name,supplement_cents,is_default,is_active,sort_order) values ((p_plan->'generatedIds'->'modifiers'->>v_ref)::uuid,v_tenant,p_venue_id,(p_plan->'generatedIds'->'modifierGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'name',(v_item->>'supplementCents')::integer,(v_item->>'isDefault')::boolean,(v_item->>'isActive')::boolean,(v_item->>'sortOrder')::integer);
  end loop;
  for v_item in select value from jsonb_array_elements(p_plan#>'{document,catalog,modifierAssignments}') loop
    v_ref:=v_item->>'ref'; v_product:=(p_plan->'generatedIds'->'products'->>(v_item->>'productRef'))::uuid; v_assignment:=(p_plan->'generatedIds'->'modifierAssignments'->>v_ref)::uuid;
    insert into public.product_modifier_group_assignments(id,tenant_id,venue_id,product_id,group_id,display_name,min_selection,max_selection,applies_to_all_variants,sort_order,is_active) values (v_assignment,v_tenant,p_venue_id,v_product,(p_plan->'generatedIds'->'modifierGroups'->>(v_item->>'groupRef'))::uuid,v_item->>'displayName',(v_item->>'minSelection')::integer,(v_item->>'maxSelection')::integer,jsonb_array_length(v_item->'variantRefs')=0,(v_item->>'sortOrder')::integer,(v_item->>'isActive')::boolean);
    for v_variant_ref in select jsonb_array_elements_text(v_item->'variantRefs') loop insert into public.product_modifier_group_assignment_variants(tenant_id,venue_id,assignment_id,product_id,variant_id) values(v_tenant,p_venue_id,v_assignment,v_product,(p_plan->'generatedIds'->'variants'->>v_variant_ref)::uuid); end loop;
  end loop;
  set constraints all immediate;
  return jsonb_build_object('result','SUCCESS','removedImagePaths',to_jsonb(v_removed_paths));
end; $$;


create or replace function public.catalog_export_ref(p_prefix text, p_id uuid)
returns text language sql immutable strict set search_path = '' as $$
  select p_prefix || '_' || replace(p_id::text, '-', '_')
$$;

create or replace function public.export_catalog(p_venue_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_venue public.venues%rowtype; v_tenant public.tenants%rowtype; v_catalog jsonb;
begin
  select * into v_venue from public.venues where id=p_venue_id;
  if not found then raise exception 'VENUE_NOT_FOUND'; end if;
  if auth.role() <> 'service_role' and not public.user_is_tenant_admin(v_venue.tenant_id) then raise exception 'CATALOG_EXPORT_FORBIDDEN'; end if;
  select * into v_tenant from public.tenants where id=v_venue.tenant_id;
  v_catalog := jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('category',c.id),'name',c.name,'icon',c.icon,'sortOrder',c.sort_order,'isActive',c.is_active,'unused',c.unused,'trace','{}'::jsonb,'source','{}'::jsonb) order by c.sort_order,c.name,c.id) from public.categories c where c.venue_id=p_venue_id),'[]'::jsonb),
    'tabs', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('tab',t.id),'key',t.key,'label',t.label,'icon',t.icon,'sortOrder',t.sort_order,'isActive',t.is_active,'trace','{}'::jsonb) order by t.sort_order,t.label,t.id) from public.catalog_tabs t where t.venue_id=p_venue_id),'[]'::jsonb),
    'tabCategories', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('tab_category',x.id),'tabRef',public.catalog_export_ref('tab',x.tab_id),'categoryRef',public.catalog_export_ref('category',x.category_id),'sortOrder',x.sort_order,'isActive',x.is_active,'source','{}'::jsonb) order by x.sort_order,x.id) from public.catalog_tab_categories x where x.venue_id=p_venue_id),'[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('product',p.id),'type',p.product_type,'name',p.name,'description',p.description,'imageRef',case when pi.id is null then null else public.catalog_export_ref('image',pi.id) end,'taxRate',p.tax_rate,'sortOrder',p.sort_order,'isActive',p.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by p.sort_order,p.name,p.id) from public.products p left join public.product_images pi on pi.product_id=p.id where p.venue_id=p_venue_id),'[]'::jsonb),
    'variants', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('variant',v.id),'productRef',public.catalog_export_ref('product',v.product_id),'name',v.name,'priceCents',v.price_cents,'sku',v.sku,'isDefault',v.is_default,'sortOrder',v.sort_order,'isActive',v.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by v.product_id,v.sort_order,v.name,v.id) from public.product_variants v where v.venue_id=p_venue_id),'[]'::jsonb),
    'placements', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('placement',x.id),'productRef',public.catalog_export_ref('product',x.product_id),'tabRef',public.catalog_export_ref('tab',x.tab_id),'categoryRef',case when x.category_id is null then null else public.catalog_export_ref('category',x.category_id) end,'variantRef',case when x.variant_id is null then null else public.catalog_export_ref('variant',x.variant_id) end,'featured',x.is_featured,'sortOrder',x.sort_order,'isActive',x.is_active,'trace','{}'::jsonb) order by x.tab_id,x.category_id nulls first,x.sort_order,x.id) from public.catalog_placements x where x.venue_id=p_venue_id),'[]'::jsonb),
    'selectionGroups', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_group',g.id),'name',g.name,'type',g.kind,'sortOrder',g.sort_order,'isActive',g.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by g.sort_order,g.name,g.id) from public.selection_groups g where g.venue_id=p_venue_id),'[]'::jsonb),
    'selectionGroupOptions', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_option',o.id),'groupRef',public.catalog_export_ref('selection_group',o.group_id),'productRef',public.catalog_export_ref('product',o.product_id),'variantRef',case when o.variant_id is null then null else public.catalog_export_ref('variant',o.variant_id) end,'supplementCents',o.supplement_cents,'defaultQuantity',o.default_quantity,'maxQuantity',o.max_quantity,'sortOrder',o.sort_order,'isActive',o.is_active,'trace','{}'::jsonb) order by o.group_id,o.sort_order,o.id) from public.selection_group_options o where o.venue_id=p_venue_id),'[]'::jsonb),
    'selectionAssignments', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('selection_assignment',a.id),'productRef',public.catalog_export_ref('product',a.product_id),'groupRef',public.catalog_export_ref('selection_group',a.group_id),'variantRefs',coalesce((select jsonb_agg(public.catalog_export_ref('variant',av.variant_id) order by av.variant_id) from public.product_selection_group_assignment_variants av where av.assignment_id=a.id),'[]'::jsonb),'minSelection',a.min_selection,'maxSelection',a.max_selection,'sortOrder',a.sort_order,'isActive',a.is_active,'displayName',a.display_name,'trace','{}'::jsonb) order by a.product_id,a.sort_order,a.id) from public.product_selection_group_assignments a where a.venue_id=p_venue_id),'[]'::jsonb),
    'modifierGroups', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier_group',g.id),'name',g.name,'sortOrder',g.sort_order,'isActive',g.is_active,'trace','{}'::jsonb,'source','{}'::jsonb) order by g.sort_order,g.name,g.id) from public.modifier_groups g where g.venue_id=p_venue_id),'[]'::jsonb),
    'modifiers', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier',m.id),'groupRef',public.catalog_export_ref('modifier_group',m.group_id),'name',m.name,'supplementCents',m.supplement_cents,'isDefault',m.is_default,'sortOrder',m.sort_order,'isActive',m.is_active,'trace','{}'::jsonb) order by m.group_id,m.sort_order,m.id) from public.modifiers m where m.venue_id=p_venue_id),'[]'::jsonb),
    'modifierAssignments', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('modifier_assignment',a.id),'productRef',public.catalog_export_ref('product',a.product_id),'groupRef',public.catalog_export_ref('modifier_group',a.group_id),'variantRefs',coalesce((select jsonb_agg(public.catalog_export_ref('variant',av.variant_id) order by av.variant_id) from public.product_modifier_group_assignment_variants av where av.assignment_id=a.id),'[]'::jsonb),'minSelection',a.min_selection,'maxSelection',a.max_selection,'sortOrder',a.sort_order,'isActive',a.is_active,'displayName',a.display_name,'trace','{}'::jsonb) order by a.product_id,a.sort_order,a.id) from public.product_modifier_group_assignments a where a.venue_id=p_venue_id),'[]'::jsonb),
    'images', coalesce((select jsonb_agg(jsonb_build_object('ref',public.catalog_export_ref('image',i.id),'productRef',public.catalog_export_ref('product',i.product_id),'file','images/'||public.catalog_export_ref('image',i.id)||case i.mime_type when 'image/jpeg' then '.jpg' when 'image/png' then '.png' when 'image/gif' then '.gif' when 'image/avif' then '.avif' else '.webp' end,'mimeType',i.mime_type,'sizeBytes',i.size_bytes,'sha256',i.sha256,'missing',false,'trace','{}'::jsonb,'source',jsonb_build_object('storagePath',i.storage_path)) order by i.product_id,i.id) from public.product_images i where i.venue_id=p_venue_id),'[]'::jsonb)
  );
  return jsonb_build_object('format','club-pos-catalog-export','schemaVersion',3,'metadata',jsonb_build_object('exportedAt',to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'origin',jsonb_build_object('tenant',jsonb_build_object('name',v_tenant.name),'venue',jsonb_build_object('name',v_venue.name)),'fiscal',jsonb_build_object('defaultTaxRate',v_venue.default_tax_rate,'currencyCode',v_venue.currency_code,'timezone',v_venue.timezone),'counts',(select jsonb_object_agg(key,jsonb_array_length(value)) from jsonb_each(v_catalog))),'catalog',v_catalog);
end; $$;


-- Obsolete RPCs are removed before their relations.
revoke all on function public.add_restaurant_order_line(uuid,uuid,uuid,uuid[],integer,text) from public,anon,authenticated;
revoke all on function public.add_restaurant_order_line_with_mixer(uuid,uuid,uuid,uuid[],integer,text,uuid) from public,anon,authenticated;
revoke all on function public.save_restaurant_order_lines(uuid,integer,jsonb) from public,anon,authenticated;
revoke all on function public.save_restaurant_order_lines_v3(uuid,integer,jsonb) from public,anon,authenticated;
revoke all on function public.canonical_catalog_component_modifiers(uuid,uuid,jsonb) from public,anon,authenticated;
drop function public.save_restaurant_order_lines_v3(uuid,integer,jsonb);
drop function public.save_restaurant_order_lines(uuid,integer,jsonb);
drop function public.add_restaurant_order_line_with_mixer(uuid,uuid,uuid,uuid[],integer,text,uuid);
drop function public.add_restaurant_order_line(uuid,uuid,uuid,uuid[],integer,text);
drop function public.canonical_catalog_component_modifiers(uuid,uuid,jsonb);

drop trigger validate_catalog_placements_relation on public.catalog_placements;
drop trigger validate_selection_group_items_relation on public.selection_group_items;
drop trigger set_selection_group_items_updated_at on public.selection_group_items;
drop trigger validate_variant_selection_groups_relation on public.variant_selection_groups;
drop trigger validate_product_modifier_groups_relation on public.product_modifier_groups;
drop trigger set_sale_formats_updated_at on public.sale_formats;
drop function public.validate_catalog_relation();

drop policy selection_group_items_select on public.selection_group_items;
drop policy selection_group_items_admin_manage on public.selection_group_items;
drop policy variant_selection_groups_select on public.variant_selection_groups;
drop policy variant_selection_groups_admin_manage on public.variant_selection_groups;
drop policy product_modifier_groups_select on public.product_modifier_groups;
drop policy product_modifier_groups_admin_manage on public.product_modifier_groups;
drop policy sale_formats_select on public.sale_formats;
drop policy sale_formats_admin_manage on public.sale_formats;
revoke all on public.selection_group_items,public.variant_selection_groups,public.product_modifier_groups,public.sale_formats from anon,authenticated;
drop policy modifier_groups_select on public.modifier_groups;
drop policy modifiers_select on public.modifiers;

drop index public.selection_group_items_identity_idx;
drop index public.selection_group_items_group_idx;
drop index public.variant_selection_groups_variant_idx;
drop index public.product_modifier_groups_identity_idx;
drop index public.product_modifier_groups_product_idx;
drop index public.product_variants_format_idx;
drop index public.sale_formats_tenant_idx;
drop index public.products_tenant_idx;
drop index public.modifier_groups_product_idx;

alter table public.products alter column sale_formats drop default;
alter table public.products alter column can_sell_standalone drop default;
alter table public.products alter column can_use_as_mixer drop default;
alter table public.products alter column is_featured drop default;
alter table public.products alter column mixer_supplement_cents drop default;
alter table public.selection_groups alter column min_select drop default;
alter table public.selection_groups alter column max_select drop default;
alter table public.modifier_groups alter column min_select drop default;
alter table public.modifier_groups alter column max_select drop default;
alter table public.modifiers alter column price_cents drop default;

alter table public.product_variants drop constraint product_variants_sale_format_id_fkey;
alter table public.catalog_placements drop constraint catalog_placements_default_variant_id_fkey;
alter table public.products drop constraint products_category_id_fkey;
alter table public.modifier_groups drop constraint modifier_groups_product_id_fkey;
alter table public.selection_groups drop constraint selection_groups_max_check;
alter table public.categories drop constraint categories_kind_check;
alter table public.products drop constraint products_kind_check;
alter table public.products drop constraint products_mixer_supplement_cents_check;
alter table public.modifier_groups drop constraint modifier_groups_min_select_check;
alter table public.modifier_groups drop constraint modifier_groups_max_select_check;
alter table public.modifiers drop constraint modifiers_price_cents_check;

drop table public.selection_group_items;
drop table public.variant_selection_groups;
drop table public.product_modifier_groups;
drop table public.sale_formats;

alter table public.categories alter column kind drop default;
alter table public.products alter column category_id drop default;
alter table public.products alter column image_path drop default;
alter table public.products alter column kind drop default;
alter table public.products alter column sale_formats drop default;
alter table public.products alter column can_sell_standalone drop default;
alter table public.products alter column can_use_as_mixer drop default;
alter table public.products alter column is_featured drop default;
alter table public.products alter column mixer_supplement_cents drop default;
alter table public.product_variants alter column sale_format_id drop default;
alter table public.catalog_placements alter column default_variant_id drop default;
alter table public.selection_groups alter column min_select drop default;
alter table public.selection_groups alter column max_select drop default;
alter table public.modifier_groups alter column product_id drop default;
alter table public.modifier_groups alter column min_select drop default;
alter table public.modifier_groups alter column max_select drop default;
alter table public.modifiers alter column price_cents drop default;

alter table public.categories drop column kind;
alter table public.products drop column category_id;
alter table public.products drop column image_path;
alter table public.products drop column kind;
alter table public.products drop column sale_formats;
alter table public.products drop column can_sell_standalone;
alter table public.products drop column can_use_as_mixer;
alter table public.products drop column is_featured;
alter table public.products drop column mixer_supplement_cents;
alter table public.product_variants drop column sale_format_id;
alter table public.catalog_placements drop column default_variant_id;
alter table public.selection_groups drop column min_select;
alter table public.selection_groups drop column max_select;
alter table public.modifier_groups drop column product_id;
alter table public.modifier_groups drop column min_select;
alter table public.modifier_groups drop column max_select;
alter table public.modifiers drop column price_cents;

alter table public.categories alter column venue_id set not null;
alter table public.product_variants alter column venue_id set not null;
alter table public.modifier_groups alter column venue_id set not null;
alter table public.modifiers alter column venue_id set not null;
create index products_venue_active_idx on public.products(tenant_id,venue_id,is_active,sort_order);
create index modifier_groups_venue_active_idx on public.modifier_groups(tenant_id,venue_id,is_active,sort_order);

drop policy categories_select on public.categories;
create policy categories_select on public.categories for select to authenticated
using(public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id,venue_id));
create policy modifier_groups_select on public.modifier_groups for select to authenticated
using(public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id,venue_id));
create policy modifiers_select on public.modifiers for select to authenticated
using(public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id,venue_id));

revoke all on function public.catalog_command(uuid,text,jsonb) from public,anon;
revoke all on function public.import_catalog(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.export_catalog(uuid) from public,anon,authenticated;
revoke all on function public.save_catalog_order_lines(uuid,integer,jsonb) from public,anon;
grant execute on function public.catalog_command(uuid,text,jsonb) to authenticated,service_role;
grant execute on function public.import_catalog(uuid,text,jsonb) to service_role;
grant execute on function public.export_catalog(uuid) to service_role;
grant execute on function public.save_catalog_order_lines(uuid,integer,jsonb) to authenticated;

comment on table public.products is 'Definitive venue-scoped catalogue products; visibility and category belong to placements.';
comment on table public.product_variants is 'Definitive sellable variants with integer-cent prices.';
comment on table public.catalog_placements is 'Definitive visibility, featured state and optional pinned variant.';
comment on table public.ticket_lines is 'Immutable history. Historical sale format columns are snapshots, never live catalogue relations.';
comment on function public.catalog_command(uuid,text,jsonb) is 'Definitive catalogue command boundary.';
comment on function public.save_catalog_order_lines(uuid,integer,jsonb) is 'Definitive order-line command using final assignments and immutable snapshots.';

do $phase4_final$
declare v_object text;
begin
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in('sale_formats','selection_group_items','variant_selection_groups','product_modifier_groups')) then
    raise exception 'PHASE4_PREFLIGHT_FAILED: legacy relation remains';
  end if;
  if exists(select 1 from information_schema.columns where table_schema='public' and (table_name,column_name) in(
    ('categories','kind'),('products','category_id'),('products','image_path'),('products','kind'),('products','sale_formats'),
    ('products','can_sell_standalone'),('products','can_use_as_mixer'),('products','is_featured'),('products','mixer_supplement_cents'),
    ('product_variants','sale_format_id'),('catalog_placements','default_variant_id'),('selection_groups','min_select'),
    ('selection_groups','max_select'),('modifier_groups','product_id'),('modifier_groups','min_select'),('modifier_groups','max_select'),('modifiers','price_cents'))) then
    raise exception 'PHASE4_PREFLIGHT_FAILED: legacy column remains';
  end if;
  select p.oid::regprocedure::text into v_object from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind='f' and pg_get_functiondef(p.oid) ~ '(sale_formats|selection_group_items|variant_selection_groups|product_modifier_groups|default_variant_id|can_use_as_mixer|mixer_supplement_cents)' limit 1;
  if v_object is not null then raise exception 'PHASE4_PREFLIGHT_FAILED: final function still references legacy: %',v_object; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in('categories','products','product_variants','catalog_tabs','catalog_tab_categories','catalog_placements','selection_groups','selection_group_options','product_selection_group_assignments','modifier_groups','modifiers','product_modifier_group_assignments','product_images') and not c.relrowsecurity) then
    raise exception 'PHASE4_PREFLIGHT_FAILED: final catalog table without RLS';
  end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform public.get_catalog(v.id,'admin') from public.venues v limit 1;
end
$phase4_final$;

select 'PHASE4_CATALOG_FINAL_CLEANUP_OK'::text as status,now() as completed_at;
commit;
