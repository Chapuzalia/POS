import { createHash } from 'node:crypto'

export const target = Object.freeze({
  sshHost: 'vps2',
  project: 'irsdd2liytrh7dttjr5rzj3j',
  api: 'https://pre-api-tpv.alteilsolutions.com',
  seed: 'tickit-staging-demos-v1',
})

export function demoId(key) {
  const hex = createHash('sha256').update(`${target.seed}:${key}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

const restaurantFeatures = ['restaurant', 'reservations', 'production', 'multi_device']
export const scenarios = [
  { key: 'bar', name: 'Demo · Bar La Esquina', features: [], venues: ['Bar La Esquina'] },
  { key: 'restaurante', name: 'Demo · Restaurante El Olivo', features: restaurantFeatures, venues: ['El Olivo'] },
  {
    key: 'grupo', name: 'Demo · Grupo Horizonte',
    features: [...restaurantFeatures, 'analytics_advanced', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'tickit_assist'],
    venues: ['Horizonte Centro', 'Horizonte Puerto', 'Horizonte Terraza'],
  },
].map(s => ({ ...s, id: demoId(s.key), slug: `demo-staging-${s.key}` }))

export function accountDefinitions() {
  return scenarios.flatMap(s => {
    const accounts = [{ key: `${s.key}/owner`, email: `demo.${s.key}@example.com`, name: `Propietario · ${s.name}`, role: 'owner', tenantId: s.id }]
    if (s.key === 'grupo') accounts.push({ key: 'grupo/manager', email: 'demo.grupo.manager@example.com', name: 'Responsable · Horizonte Centro', role: 'manager', tenantId: s.id, venueIds: [demoId('grupo/venue/0')] })
    s.venues.forEach((venue, i) => {
      const venueKey = `${s.key}/venue/${i}`
      const modes = s.key === 'bar' ? ['checkout'] : ['hybrid', 'satellite', 'kds']
      modes.forEach(mode => accounts.push({
        key: `${venueKey}/${mode}`, email: `demo.${s.key}.${i + 1}.${mode}@example.com`,
        name: `${mode === 'satellite' ? 'Comandero' : mode === 'kds' ? 'Cocina KDS' : 'TPV'} · ${venue}`,
        role: 'cashier', tenantId: s.id, venueId: demoId(venueKey), deviceId: demoId(`${venueKey}/${mode}`), mode,
      }))
    })
    return accounts
  })
}

const barMenu = [
  ['Cervezas', 'beer_bottle', [['Caña', 250], ['Doble', 350], ['Cerveza sin alcohol', 300]]],
  ['Cafés y refrescos', 'cup_soda', [['Café solo', 150], ['Café con leche', 180], ['Refresco', 280], ['Agua mineral', 200]]],
  ['Vinos', 'wine', [['Vino tinto', 300], ['Vino blanco', 300]]],
  ['Tapas', 'utensils', [['Tortilla de patata', 350], ['Aceitunas', 200], ['Ensaladilla', 450]]],
]
const restaurantMenu = [
  ['Entrantes', 'salad', [['Ensalada de temporada', 950], ['Croquetas caseras', 1050], ['Patatas bravas', 650], ['Tabla de quesos', 1400]]],
  ['Principales', 'utensils', [['Hamburguesa de la casa', 1450], ['Pollo a la plancha', 1350], ['Arroz de verduras', 1550], ['Merluza al horno', 1850]]],
  ['Postres', 'dessert', [['Tarta de queso', 600], ['Brownie con helado', 650], ['Fruta de temporada', 450]]],
  ['Bebidas', 'cup_soda', [['Agua mineral', 220], ['Refresco', 300], ['Cerveza', 350], ['Copa de vino', 380], ['Café', 180]]],
]

export function buildRows(accounts) {
  const rows = []
  const add = (table, key, data, conflict = ['id']) => {
    const row = key === null ? data : { id: demoId(key), ...data }
    rows.push({ table, row, conflict })
    return row.id
  }
  for (const s of scenarios) {
    add('tenants', s.key, { name: s.name, slug: s.slug, max_venues: s.venues.length, max_devices: s.key === 'bar' ? 1 : s.venues.length * 3 })
    for (const feature of s.features) add('tenant_feature_assignments', null, { tenant_id: s.id, feature_key: feature }, ['tenant_id', 'feature_key'])
    // The default tenant trigger grants legacy optional features; SQL below removes
    // only defaults outside this explicit scenario allowlist.
    for (const [i, name] of s.venues.entries()) {
      const v = `${s.key}/venue/${i}`
      const venueId = demoId(v)
      const scope = { tenant_id: s.id, venue_id: venueId }
      const restaurant = s.key !== 'bar'
      const full = s.key === 'grupo'
      add('venues', v, {
        tenant_id: s.id, name, sort_order: i + 1, catalog_profile: restaurant ? 'restaurant' : 'bar_classic',
        tables_enabled: restaurant, production_enabled: restaurant, inventory_enabled: full,
        default_tax_rate: 10, manual_discount_enabled: full, tickit_assist_enabled: false,
        address: 'Dirección ficticia · DEMO STAGING', timezone: 'Europe/Madrid', currency_code: 'EUR',
      })
      add('venue_addon_assignments', null, { ...scope, addon_key: 'cashlogy', is_enabled: false }, ['venue_id', 'addon_key'])
      const tab = add('catalog_tabs', `${v}/tab`, { ...scope, key: restaurant ? 'carta' : 'barra', label: restaurant ? 'Carta' : 'Barra', icon: restaurant ? 'utensils' : 'cocktail', sort_order: 1 })
      const format = add('catalog_sale_formats', `${v}/format`, { ...scope, name: 'Unidad', sort_order: 1 })
      const destination = restaurant ? add('production_destinations', `${v}/kitchen`, { ...scope, name: 'Cocina', kds_enabled: true, sort_order: 1 }) : null
      const products = []
      const menu = restaurant ? restaurantMenu : barMenu
      for (const [ci, [categoryName, icon, entries]] of menu.entries()) {
        const category = add('categories', `${v}/category/${ci}`, { ...scope, name: categoryName, icon, sort_order: ci + 1 })
        add('catalog_tab_categories', `${v}/tab-category/${ci}`, { ...scope, tab_id: tab, category_id: category, sort_order: ci + 1 })
        if (restaurant && categoryName !== 'Bebidas') add('production_category_routes', null, { ...scope, category_id: category, destination_id: destination }, ['venue_id', 'category_id'])
        for (const [pi, [productName, price]] of entries.entries()) {
          const pk = `${v}/product/${ci}/${pi}`
          const product = add('products', pk, { ...scope, name: productName, description: 'Producto ficticio de demostración', sort_order: ci * 10 + pi, tax_rate: 10 })
          const variant = add('product_variants', `${pk}/variant`, { ...scope, product_id: product, name: 'Unidad', price_cents: price, is_default: true, catalog_sale_format_id: format })
          add('catalog_placements', `${pk}/placement`, { ...scope, tab_id: tab, category_id: category, product_id: product, sort_order: pi + 1 })
          products.push({ product, variant, productName, key: pk })
        }
      }
      if (restaurant) {
        for (const [ai, areaName] of ['Salón', 'Terraza'].entries()) {
          const area = add('dining_areas', `${v}/area/${ai}`, { ...scope, name: areaName, sort_order: ai + 1 })
          for (let ti = 0; ti < 6; ti++) add('restaurant_tables', `${v}/area/${ai}/table/${ti}`, {
            ...scope, area_id: area, name: `${ai === 0 ? 'S' : 'T'}${ti + 1}`, capacity: ti < 2 ? 2 : 4,
            shape: ti < 2 ? 'round' : 'square', position_x: 12 + (ti % 3) * 30, position_y: 15 + Math.floor(ti / 3) * 40,
            width: 15, height: 18, sort_order: ti + 1,
          })
        }
        const group = add('modifier_groups', `${v}/cooking`, { ...scope, name: 'Punto de cocción', sort_order: 1 })
        for (const [mi, modifier] of ['Poco hecha', 'Al punto', 'Muy hecha'].entries()) add('modifiers', `${v}/cooking/${mi}`, { ...scope, group_id: group, name: modifier, sort_order: mi + 1, is_default: mi === 1 })
        add('product_modifier_group_assignments', `${v}/burger-cooking`, { ...scope, product_id: products.find(p => p.productName === 'Hamburguesa de la casa').product, group_id: group, min_selection: 1, max_selection: 1 })
      }
      if (full) {
        const warehouse = add('inventory_warehouses', `${v}/warehouse`, { ...scope, name: 'Almacén principal', sort_order: 1 })
        const unitId = demoId(`${v}/unit`)
        add('inventory_units', `${v}/unit`, { ...scope, name: 'Unidad', symbol: 'ud', decimal_places: 0, content_quantity: 1, content_unit_id: unitId })
        for (const p of products.filter(p => ['Agua mineral', 'Refresco', 'Cerveza', 'Tarta de queso'].includes(p.productName))) {
          const item = add('inventory_items', `${p.key}/item`, { ...scope, name: p.productName, base_unit_id: unitId })
          add('inventory_stock_levels', null, { ...scope, warehouse_id: warehouse, inventory_item_id: item, quantity: 100, target_quantity: 30 }, ['warehouse_id', 'inventory_item_id'])
          add('inventory_stock_movements', `${p.key}/opening-stock`, { ...scope, warehouse_id: warehouse, inventory_item_id: item, unit_id: unitId, content_unit_id: unitId, source_type: 'adjustment', stock_quantity_delta: 100, stock_quantity_before: 0, stock_quantity_after: 100, metadata: { seed: target.seed } })
          add('inventory_item_warehouse_routes', null, { ...scope, warehouse_id: warehouse, inventory_item_id: item, priority: 1 }, ['inventory_item_id', 'warehouse_id'])
          const recipe = add('inventory_recipes', `${p.key}/recipe`, { ...scope, variant_id: p.variant, mode: 'direct' })
          add('inventory_recipe_lines', `${p.key}/recipe-line`, { ...scope, recipe_id: recipe, inventory_item_id: item, quantity: 1, unit_id: unitId })
        }
        for (const [si, supplier] of ['Distribuciones Demo', 'Mercado Demo'].entries()) add('suppliers', `${v}/supplier/${si}`, { ...scope, name: supplier, email: `proveedor${si + 1}@example.com` })
        add('discounts', `${v}/discount`, { ...scope, name: 'Descuento demo 10 %', type: 'percentage', value: 10, auto_apply: false })
      }
    }
    add('fiscal_integration_settings', null, { tenant_id: s.id, enabled: false, automatic_submission: false, webhooks_enabled: false }, ['tenant_id'])
  }
  // All users are provisioned through Auth Admin, never raw auth.users SQL.
  for (const a of accounts) {
    if (!a.id) throw new Error(`Falta el ID de Auth de ${a.key}`)
    rows.push({ table: 'profiles', row: { id: a.id, full_name: a.name, is_superadmin: false }, conflict: ['id'] })
    add('tenant_memberships', `${a.key}/membership`, { tenant_id: a.tenantId, user_id: a.id, role: a.role })
    for (const venueId of a.venueIds ?? []) add('manager_venue_assignments', null, { tenant_id: a.tenantId, manager_user_id: a.id, venue_id: venueId }, ['tenant_id', 'manager_user_id', 'venue_id'])
    if (!a.deviceId) continue
    const cash = ['checkout', 'hybrid'].includes(a.mode)
    const v = a.key.slice(0, a.key.lastIndexOf('/'))
    rows.push({ table: 'devices', row: {
      id: a.deviceId, tenant_id: a.tenantId, venue_id: a.venueId, name: a.name.split(' · ')[0], device_mode: a.mode,
      can_take_orders: a.mode !== 'kds', can_take_payments: cash, can_open_cash_session: cash, can_close_cash_session: cash, can_manage_cash: cash,
      production_destination_id: a.mode === 'kds' ? demoId(`${v}/kitchen`) : null,
    }, conflict: ['id'] })
    add('device_user_assignments', `${a.key}/assignment`, { tenant_id: a.tenantId, venue_id: a.venueId, user_id: a.id, device_id: a.deviceId })
  }
  return rows
}

export const quoteSql = value => `'${String(value).replaceAll("'", "''")}'`
const sqlValue = value => value === null ? 'null' : typeof value === 'boolean' || typeof value === 'number' ? String(value) : quoteSql(typeof value === 'object' ? JSON.stringify(value) : value)

export function preflightSql() {
  return `do $guard$ begin
    if current_setting('tickit.demo_target',true) is distinct from ${quoteSql(target.project)} then raise exception 'STAGING_DEMO_TARGET_REQUIRED'; end if;
    ${scenarios.map(s => `if exists(select 1 from public.tenants where (id=${quoteSql(s.id)} and slug<>${quoteSql(s.slug)}) or (slug=${quoteSql(s.slug)} and id<>${quoteSql(s.id)})) then raise exception 'DEMO_TENANT_COLLISION'; end if;
    if exists(select 1 from public.tenant_verifactu_integrations where tenant_id=${quoteSql(s.id)} and (requested_at is not null or enabled_at is not null)) or exists(select 1 from public.fiscal_integration_settings where tenant_id=${quoteSql(s.id)} and enabled) or exists(select 1 from public.fiscal_pos_bridge_settings where tenant_id=${quoteSql(s.id)}) then raise exception 'DEMO_HAS_FISCAL_CONFIGURATION'; end if;`).join('\n')}
  end $guard$;`
}

export function seedSql(accounts, { rollback = false } = {}) {
  const statements = ['begin;', "set local lock_timeout='5s';", "set local statement_timeout='60s';", "select pg_advisory_xact_lock(hashtextextended('tickit-staging-demos-v1',0));", preflightSql()]
  for (const { table, row, conflict } of buildRows(accounts)) {
    // Skip existing rows before INSERT so plan-limit BEFORE triggers do not
    // reject an idempotent rerun when a demo already uses its full device limit.
    const existing = conflict.map(key => `${key}=${sqlValue(row[key])}`).join(' and ')
    statements.push(`insert into public.${table} (${Object.keys(row).join(',')}) select ${Object.values(row).map(sqlValue).join(',')} where not exists(select 1 from public.${table} where ${existing}) on conflict (${conflict.join(',')}) do nothing;`)
  }
  for (const s of scenarios) statements.push(`delete from public.tenant_feature_assignments where tenant_id=${quoteSql(s.id)} and feature_key not in (${[...s.features, '__no_feature__'].map(quoteSql).join(',')});`)
  // Never reactivate an integration on rerun, even if demo settings changed.
  statements.push(`update public.venue_addon_assignments set is_enabled=false where tenant_id in (${scenarios.map(s => quoteSql(s.id)).join(',')}) and addon_key='cashlogy';`)
  statements.push(rollback ? 'rollback;' : 'commit;')
  return statements.join('\n')
}

export function reportSql() {
  return `select coalesce(json_agg(result),'[]'::json) from (
    select t.id,t.slug,t.name,
      (select count(*) from public.venues where tenant_id=t.id) venues,
      (select count(*) from public.products where tenant_id=t.id) products,
      (select count(*) from public.restaurant_tables where tenant_id=t.id) tables,
      (select count(*) from public.devices where tenant_id=t.id) devices,
      (select count(*) from public.cash_registers where tenant_id=t.id and is_active) cash_registers,
      (select count(*) from public.tenant_memberships where tenant_id=t.id) users,
      public.tenant_addon_enabled(t.id,'cashlogy') cashlogy,
      exists(select 1 from public.tenant_verifactu_integrations where tenant_id=t.id and enabled_at is not null) verifactu,
      exists(select 1 from public.fiscal_integration_settings where tenant_id=t.id and enabled) legacy_fiscal,
      (select coalesce(json_agg(feature_key order by feature_key),'[]') from public.tenant_feature_assignments where tenant_id=t.id) features
    from public.tenants t where id in (${scenarios.map(s => quoteSql(s.id)).join(',')}) order by slug
  ) result;`
}
