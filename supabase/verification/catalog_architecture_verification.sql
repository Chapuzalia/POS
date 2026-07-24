-- Read-only verification for 0.Complete_Database_24-07-26.sql.
-- Every result set should return zero rows/count zero unless its label says INFO.

select 'ERROR venues_without_profile' as check_name, count(*) as affected
from public.venues where catalog_profile is null or catalog_profile not in ('bar_classic','restaurant','custom');

select 'ERROR active_venues_without_tabs' as check_name, count(*) as affected
from public.venues v where v.is_active and not exists (
  select 1 from public.catalog_tabs ct where ct.tenant_id = v.tenant_id and ct.venue_id = v.id and ct.is_active
);

select 'ERROR active_products_without_placements' as check_name, count(*) as affected
from public.products p where p.is_active and p.can_sell_standalone and not exists (
  select 1 from public.catalog_placements cp where cp.product_id = p.id and cp.venue_id = p.venue_id and cp.is_active
);

select 'ERROR placement_orphans_or_scope_mismatch' as check_name, count(*) as affected
from public.catalog_placements cp
left join public.products p on p.id = cp.product_id
left join public.categories c on c.id = cp.category_id
left join public.catalog_tabs ct on ct.id = cp.tab_id
where p.id is null or c.id is null or ct.id is null
  or p.tenant_id <> cp.tenant_id or p.venue_id <> cp.venue_id
  or c.tenant_id <> cp.tenant_id or ct.tenant_id <> cp.tenant_id or ct.venue_id <> cp.venue_id;

select 'ERROR placement_invalid_default_variant' as check_name, count(*) as affected
from public.catalog_placements cp
left join public.product_variants pv on pv.id = cp.default_variant_id
where cp.default_variant_id is not null and (pv.id is null or pv.product_id <> cp.product_id or not pv.is_active);

select 'REVIEW active_variants_without_format' as check_name, count(*) as affected,
  jsonb_agg(jsonb_build_object('variantId', pv.id, 'productId', pv.product_id, 'name', pv.name)) filter (where pv.id is not null) as samples
from public.product_variants pv join public.products p on p.id = pv.product_id
where pv.is_active and pv.sale_format_id is null and cardinality(p.sale_formats) > 0;

select 'ERROR duplicate_product_format_variants' as check_name, count(*) as affected
from (
  select product_id, sale_format_id from public.product_variants
  where is_active and sale_format_id is not null
  group by product_id, sale_format_id having count(*) > 1
) duplicates;

select 'ERROR multiple_active_default_variants' as check_name, count(*) as affected
from (
  select product_id from public.product_variants where is_active and is_default
  group by product_id having count(*) > 1
) duplicates;

select 'ERROR legacy_mixers_not_migrated' as check_name, count(*) as affected
from public.products p where p.can_use_as_mixer and p.is_active and not exists (
  select 1 from public.selection_group_items sgi join public.selection_groups sg on sg.id = sgi.group_id
  where sgi.product_id = p.id and sgi.is_active and sg.kind = 'mixer' and sg.venue_id = p.venue_id
);

select 'ERROR active_groups_without_items' as check_name, count(*) as affected
from public.selection_groups sg where sg.is_active and not exists (
  select 1 from public.selection_group_items sgi where sgi.group_id = sg.id and sgi.is_active
);

select 'ERROR cubata_variants_without_mixer_group' as check_name, count(*) as affected
from public.product_variants pv join public.sale_formats sf on sf.id = pv.sale_format_id and sf.key = 'cubata'
where pv.is_active and not exists (
  select 1 from public.variant_selection_groups vsg join public.selection_groups sg on sg.id = vsg.selection_group_id
  where vsg.variant_id = pv.id and sg.kind = 'mixer' and sg.is_active
);

select 'ERROR contextual_supplement_differs_from_legacy' as check_name, count(*) as affected
from public.products p join public.selection_group_items sgi on sgi.product_id = p.id
join public.selection_groups sg on sg.id = sgi.group_id and sg.kind = 'mixer'
where p.can_use_as_mixer and sgi.price_delta_cents <> p.mixer_supplement_cents;

select 'ERROR duplicate_tabs' as check_name, count(*) as affected
from (select tenant_id, venue_id, key from public.catalog_tabs group by tenant_id, venue_id, key having count(*) > 1) duplicates;

select 'ERROR duplicate_placements' as check_name, count(*) as affected
from (select tenant_id, venue_id, tab_id, category_id, product_id from public.catalog_placements group by tenant_id, venue_id, tab_id, category_id, product_id having count(*) > 1) duplicates;

select 'ERROR selection_reference_or_scope_mismatch' as check_name, count(*) as affected
from public.selection_group_items sgi
left join public.selection_groups sg on sg.id = sgi.group_id
left join public.products p on p.id = sgi.product_id
left join public.product_variants pv on pv.id = sgi.variant_id
where sg.id is null or p.id is null or sg.tenant_id <> sgi.tenant_id or p.tenant_id <> sgi.tenant_id
  or p.venue_id <> sg.venue_id or (sgi.variant_id is not null and (pv.id is null or pv.product_id <> p.id));

select 'ERROR variant_group_scope_mismatch' as check_name, count(*) as affected
from public.variant_selection_groups vsg
left join public.product_variants pv on pv.id = vsg.variant_id
left join public.products p on p.id = pv.product_id
left join public.selection_groups sg on sg.id = vsg.selection_group_id
where pv.id is null or p.id is null or sg.id is null or vsg.tenant_id <> p.tenant_id
  or vsg.tenant_id <> sg.tenant_id or p.venue_id <> sg.venue_id;

select 'REVIEW historical_lines_with_approximate_or_missing_snapshots' as check_name, count(*) as affected
from public.ticket_lines
where category_name_snapshot is null or sale_format_name_snapshot is null or catalog_tab_id_snapshot is null;

select 'ERROR ticket_component_orphans_or_scope_mismatch' as check_name, count(*) as affected
from public.ticket_line_components c
left join public.ticket_lines tl on tl.id = c.ticket_line_id
where tl.id is null or tl.tenant_id <> c.tenant_id;

select 'ERROR order_component_orphans_or_scope_mismatch' as check_name, count(*) as affected
from public.order_line_components c
left join public.order_lines ol on ol.id = c.order_line_id
where ol.id is null or ol.tenant_id <> c.tenant_id or ol.venue_id <> c.venue_id;

select 'INFO catalogue_counts' as check_name,
  (select count(*) from public.venues) as venues,
  (select count(*) from public.products) as legacy_products,
  (select count(*) from public.product_variants) as legacy_and_new_variants,
  (select count(*) from public.catalog_tabs) as tabs,
  (select count(*) from public.catalog_placements) as placements,
  (select count(distinct product_id) from public.catalog_placements) as placed_products,
  (select count(*) from public.products where can_use_as_mixer) as legacy_mixers,
  (select count(distinct sgi.product_id) from public.selection_group_items sgi join public.selection_groups sg on sg.id = sgi.group_id where sg.kind = 'mixer') as migrated_mixers;

select 'INFO immutable_price_fingerprint' as check_name,
  count(*) as variant_count,
  sum(price_cents::bigint) as price_sum,
  md5(string_agg(id::text || ':' || price_cents::text, ',' order by id)) as price_fingerprint
from public.product_variants;

