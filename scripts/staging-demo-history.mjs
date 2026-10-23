import { createHash } from 'node:crypto'
import { demoId, preflightSql, quoteSql, scenarios, target } from './staging-demo-data.mjs'

export const historySeed = `${target.seed}:history-v1`
const dayMs = 86_400_000
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
const localFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
export const madridDate = date => dateFormatter.format(date)
export function addDays(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10) }
export function madridIso(date, hour = 0, minute = 0) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`)
  const p = Object.fromEntries(localFormatter.formatToParts(new Date(guess)).map(x => [x.type, x.value]))
  const shifted = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return new Date(guess - (shifted - guess)).toISOString()
}
function randomFor(key) {
  let n = createHash('sha256').update(key).digest().readUInt32LE()
  return max => {
    n ^= n << 13; n ^= n >>> 17; n ^= n << 5
    return (n >>> 0) % max
  }
}

export function sourceSql() {
  return `${preflightSql()}
    select json_build_object('venues', (select json_agg(row_to_json(v)) from (
      select v.id,v.tenant_id,v.name,v.inventory_enabled,v.timezone,v.day_change_time from public.venues v
      where v.id in (${scenarios.flatMap(s => s.venues.map((_, i) => quoteSql(demoId(`${s.key}/venue/${i}`)))).join(',')}) order by v.id
    ) v), 'products', (select json_agg(row_to_json(p)) from (
      select p.id,p.tenant_id,p.venue_id,p.name,p.sort_order,p.tax_rate,pv.id variant_id,pv.name variant_name,pv.price_cents,
        c.id category_id,c.name category_name,t.id tab_id,t.label tab_name,pv.catalog_sale_format_id,
        item.id inventory_item_id,route.warehouse_id
      from public.products p join public.product_variants pv on pv.product_id=p.id and pv.tenant_id=p.tenant_id and pv.venue_id=p.venue_id and pv.is_default and pv.is_active
      join public.catalog_placements placement on placement.product_id=p.id and placement.tenant_id=p.tenant_id and placement.venue_id=p.venue_id and placement.is_active
      join public.categories c on c.id=placement.category_id and c.tenant_id=p.tenant_id and c.venue_id=p.venue_id
      join public.catalog_tabs t on t.id=placement.tab_id and t.tenant_id=p.tenant_id and t.venue_id=p.venue_id
      left join public.inventory_recipes recipe on recipe.variant_id=pv.id and recipe.is_active and recipe.mode='direct'
      left join public.inventory_recipe_lines line on line.recipe_id=recipe.id and line.quantity=1
      left join public.inventory_items item on item.id=line.inventory_item_id and item.tenant_id=p.tenant_id and item.venue_id=p.venue_id
      left join public.inventory_item_warehouse_routes route on route.inventory_item_id=item.id and route.is_enabled and route.priority=1
      where p.is_active and p.tenant_id in (${scenarios.map(s => quoteSql(s.id)).join(',')}) order by p.venue_id,p.sort_order,p.id
    ) p));`
}

export function createHistoryPlan(source, accounts, asOf = new Date()) {
  const endDate = madridDate(asOf)
  const startDate = addDays(endDate, -89)
  const sessions = []
  for (const scenario of scenarios) {
    for (const [vi, venueName] of scenario.venues.entries()) {
      const venueId = demoId(`${scenario.key}/venue/${vi}`)
      const venue = source.venues.find(v => v.id === venueId && v.tenant_id === scenario.id)
      if (!venue || venue.timezone !== 'Europe/Madrid' || venue.day_change_time !== null) throw new Error(`Local demo ausente o calendario modificado: ${venueName}`)
      const actor = accounts.find(a => a.venueId === venueId && ['hybrid', 'checkout'].includes(a.mode))
      if (!actor?.id) throw new Error(`Falta la cuenta de caja: ${venueName}`)
      const products = source.products.filter(p => p.tenant_id === scenario.id && p.venue_id === venueId)
      const expected = scenario.key === 'bar' ? 12 : 16
      if (products.length !== expected || new Set(products.map(p => p.id)).size !== expected || products.some(p => !Number.isSafeInteger(p.price_cents) || p.price_cents <= 0)) throw new Error(`Catálogo demo incompleto: ${venueName}`)
      for (let day = 0; day < 90; day++) {
        const date = addDays(startDate, day)
        const key = `${historySeed}/${venueId}/${date}`
        const random = randomFor(key)
        const bar = scenario.key === 'bar'
        const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
        const weekend = [0, 5, 6].includes(weekday)
        const base = bar ? 16 : scenario.key === 'restaurante' ? 12 : [20, 24, 15][vi]
        const volume = base + random(8) + (weekend ? 9 : 0) + Math.floor(day / 30) * 2
        const openedAt = madridIso(date, bar ? 8 : 11)
        const regularClose = Date.parse(madridIso(date, 23, 30))
        const closedAt = new Date(date === endDate ? Math.min(regularClose, asOf.getTime() - 15 * 60_000) : regularClose).toISOString()
        if (Date.parse(closedAt) < Date.parse(openedAt) + 30 * 60_000) throw new Error('Genera el histórico después de la apertura de los locales')
        const sessionId = demoId(key)
        const events = []
        const consumption = new Map()
        for (let ti = 0; ti < volume; ti++) {
          const ticketKey = `${key}/ticket/${ti}`
          const ticketId = demoId(ticketKey)
          const saleId = demoId(`${ticketKey}/sale`)
          const progress = Math.floor((Date.parse(closedAt) - Date.parse(openedAt) - 120_000) * (ti + 1) / (volume + 1))
          const createdAt = new Date(Date.parse(openedAt) + 60_000 + progress).toISOString()
          const chosen = []
          if (bar) {
            for (let li = 0, count = 1 + random(3); li < count; li++) chosen.push(products[random(products.length)])
          } else {
            const inCategory = name => products.filter(p => p.category_name === name)
            const pick = name => { const options = inCategory(name); return options[random(options.length)] }
            if (random(3) !== 0) chosen.push(pick('Entrantes'))
            chosen.push(pick('Principales'), pick('Bebidas'))
            if (random(2) === 0) chosen.push(pick('Postres'))
          }
          const discounted = scenario.key === 'grupo' && ti % 9 === 0
          const lines = chosen.map((p, li) => {
            const quantity = bar ? 1 + random(3) : 1 + (random(4) === 0 ? 1 : 0)
            const gross = p.price_cents * quantity
            const discount = discounted ? Math.floor((gross + 5) / 10) : 0
            const modifiers = p.name === 'Hamburguesa de la casa' ? [{ id: demoId(`${scenario.key}/venue/${vi}/cooking/${ti % 3}`), groupId: demoId(`${scenario.key}/venue/${vi}/cooking`), name: ['Poco hecha', 'Al punto', 'Muy hecha'][ti % 3], supplementCents: 0 }] : []
            if (venue.inventory_enabled && p.inventory_item_id) {
              if (!p.warehouse_id) throw new Error('Ruta de inventario incompleta')
              const entry = consumption.get(p.inventory_item_id) ?? { itemId: p.inventory_item_id, warehouseId: p.warehouse_id, quantity: 0 }
              entry.quantity += quantity
              consumption.set(p.inventory_item_id, entry)
            }
            return {
              id: demoId(`${ticketKey}/line/${li}`), tenantId: scenario.id, ticketId, productId: p.id, variantId: p.variant_id,
              productName: p.name, variantName: p.variant_name, quantity, unitPriceCents: p.price_cents, lineTotalCents: gross,
              discountAmountCents: discount, netTotalCents: gross - discount, basePriceCents: p.price_cents,
              componentDeltaCents: 0, modifierDeltaCents: 0, grossBeforeDiscountCents: p.price_cents, modifiers, components: [],
              catalogSnapshot: { categoryId: p.category_id, categoryName: p.category_name, catalogTabId: p.tab_id, catalogTabName: p.tab_name },
            }
          })
          const subtotal = lines.reduce((sum, l) => sum + l.lineTotalCents, 0)
          const discount = lines.reduce((sum, l) => sum + l.discountAmountCents, 0)
          const total = subtotal - discount
          const method = random(100) < (bar ? 58 : 32) ? 'cash' : 'card'
          const received = method === 'cash' ? Math.ceil(total / 500) * 500 : null
          const identity = { tenantId: scenario.id, cashSessionId: sessionId, cashRegisterId: actor.deviceId, venueId, deviceId: actor.deviceId, userId: actor.id }
          events.push({
            id: demoId(`${ticketKey}/event`), payload: {
              demoHistorySeed: historySeed,
              ticket: { ...identity, id: ticketId, createdAt, subtotalCents: subtotal, discountAmountCents: discount, totalCents: total,
                discount: discounted ? { discountId: demoId(`${scenario.key}/venue/${vi}/discount`), name: 'Descuento demo 10 %', type: 'percentage', calculationType: 'percentage', storedValue: 10, value: 10, amountCents: discount, scope: 'general', ruleKind: 'discount', automatic: false } : null },
              sale: { ...identity, id: saleId, ticketId, createdAt, totalCents: total, paymentMethod: method },
              payment: { id: demoId(`${ticketKey}/payment`), tenantId: scenario.id, saleId, method, amountCents: total, receivedCents: received, changeCents: method === 'cash' ? received - total : 0 },
              lines,
            },
          })
        }
        const cash = events.reduce((sum, e) => sum + (e.payload.payment.method === 'cash' ? e.payload.payment.amountCents : 0), 0)
        const card = events.reduce((sum, e) => sum + (e.payload.payment.method === 'card' ? e.payload.payment.amountCents : 0), 0)
        const withdrawal = day % 7 === 0 ? Math.min(2000, cash) : 0
        const discrepancy = day % 23 === 0 ? -100 : day % 31 === 0 ? 50 : 0
        sessions.push({
          id: sessionId, key, tenantId: scenario.id, venueId, venueName, actorId: actor.id, deviceId: actor.deviceId, date,
          openedAt, closedAt, events, replenishments: [...consumption.values()], withdrawal, firstDay: day === 0,
          expectedCashCents: 10000 + cash - withdrawal, expectedCardCents: card,
          countedCashCents: 10000 + cash - withdrawal + discrepancy, discrepancy,
          totalCents: cash + card, notes: `DEMO HISTORY v1 | ${date} | ${venueName}`,
        })
      }
    }
  }
  return { seed: historySeed, project: target.project, api: target.api, asOf: asOf.toISOString(), startDate, endDate, sessions }
}

export function historySessionSql(s, { rollback = false } = {}) {
  const q = quoteSql
  return `begin;
    set local lock_timeout='5s'; set local statement_timeout='90s'; set local client_min_messages='warning';
    select pg_advisory_xact_lock(hashtextextended(${q(historySeed)},0));
    ${preflightSql()}
    do $history$
    declare batch jsonb := ${q(JSON.stringify(s))}::jsonb; event jsonb; restock jsonb; before_stock numeric;
    begin
      if not exists(select 1 from public.tenants where id=${q(s.tenantId)} and slug in ('demo-staging-bar','demo-staging-restaurante','demo-staging-grupo'))
        or not exists(select 1 from auth.users where id=${q(s.actorId)} and raw_app_meta_data->>'demo_seed'=${q(target.seed)})
        or not exists(select 1 from public.device_user_assignments where tenant_id=${q(s.tenantId)} and venue_id=${q(s.venueId)} and device_id=${q(s.deviceId)} and user_id=${q(s.actorId)} and is_active)
        or exists(select 1 from public.tenant_verifactu_integrations where tenant_id=${q(s.tenantId)})
        then raise exception 'DEMO_HISTORY_IDENTITY_OR_FISCAL_GUARD'; end if;
      if exists(select 1 from public.cash_sessions where id=${q(s.id)}) then
        if not exists(select 1 from public.cash_sessions where id=${q(s.id)} and tenant_id=${q(s.tenantId)} and venue_id=${q(s.venueId)} and status='closed' and notes=${q(s.notes)} and opened_at=${q(s.openedAt)}::timestamptz and closed_at=${q(s.closedAt)}::timestamptz)
          or (select count(*) from public.tickets where cash_session_id=${q(s.id)})<>${s.events.length}
          or (select coalesce(sum(total_cents),0) from public.sales where cash_session_id=${q(s.id)})<>${s.totalCents}
          then raise exception 'DEMO_HISTORY_EXISTING_SESSION_MISMATCH'; end if;
        return;
      end if;
      perform set_config('request.jwt.claim.sub',${q(s.actorId)},true);
      perform set_config('request.jwt.claim.role','authenticated',true);
      insert into public.cash_sessions(id,tenant_id,venue_id,device_id,cash_register_id,opened_by_device_id,opened_by,status,opening_float_cents,opened_at,created_at,notes,sync_source)
        values(${q(s.id)},${q(s.tenantId)},${q(s.venueId)},${q(s.deviceId)},${q(s.deviceId)},${q(s.deviceId)},${q(s.actorId)},'open',10000,${q(s.openedAt)},${q(s.openedAt)},${q(s.notes)},'staging_demo');
      if coalesce((batch->>'firstDay')::boolean,false) then
        update public.inventory_stock_movements set created_at=${q(s.openedAt)}::timestamptz-interval '1 hour'
          where tenant_id=${q(s.tenantId)} and venue_id=${q(s.venueId)} and metadata->>'seed'=${q(target.seed)};
      end if;
      for restock in select value from jsonb_array_elements(batch->'replenishments') loop
        select quantity into before_stock from public.inventory_stock_levels where inventory_item_id=(restock->>'itemId')::uuid and warehouse_id=(restock->>'warehouseId')::uuid and tenant_id=${q(s.tenantId)} and venue_id=${q(s.venueId)} for update;
        if before_stock is null then raise exception 'DEMO_HISTORY_STOCK_MISSING'; end if;
        if before_stock < (restock->>'quantity')::integer + 30 then
          perform public.increment_inventory_item_stock(${q(s.tenantId)},${q(s.venueId)},(restock->>'itemId')::uuid,(restock->>'warehouseId')::uuid,150,'adjustment',${q(s.id)},jsonb_build_object('seed',${q(historySeed)},'reason','Reposición ficticia demo'));
          update public.inventory_stock_movements set created_at=${q(s.openedAt)}::timestamptz where tenant_id=${q(s.tenantId)} and source_id=${q(s.id)} and inventory_item_id=(restock->>'itemId')::uuid;
        end if;
      end loop;
      for event in select value from jsonb_array_elements(batch->'events') loop
        perform public.sync_sale_created_v2((event->>'id')::uuid,event->'payload');
        update public.ticket_lines set created_at=(event->'payload'->'ticket'->>'createdAt')::timestamptz where tenant_id=${q(s.tenantId)} and ticket_id=(event->'payload'->'ticket'->>'id')::uuid;
        update public.sale_payments set created_at=(event->'payload'->'sale'->>'createdAt')::timestamptz where tenant_id=${q(s.tenantId)} and sale_id=(event->'payload'->'sale'->>'id')::uuid;
        update public.offline_event_log set created_at=(event->'payload'->'sale'->>'createdAt')::timestamptz where tenant_id=${q(s.tenantId)} and client_event_id=(event->>'id')::uuid;
        update public.inventory_stock_movements m set created_at=(event->'payload'->'sale'->>'createdAt')::timestamptz where m.tenant_id=${q(s.tenantId)} and m.ticket_line_id in (select id from public.ticket_lines where tenant_id=${q(s.tenantId)} and ticket_id=(event->'payload'->'ticket'->>'id')::uuid);
      end loop;
      if ${s.withdrawal}>0 then
        insert into public.cash_movements(id,tenant_id,venue_id,cash_session_id,created_by,direction,amount_cents,category,notes,created_at,request_id)
          values(${q(demoId(`${s.key}/withdrawal`))},${q(s.tenantId)},${q(s.venueId)},${q(s.id)},${q(s.actorId)},'exit',${s.withdrawal},'cash_out','Retirada ficticia demo',${q(s.closedAt)},${q(demoId(`${s.key}/withdrawal`))});
      end if;
      perform public.close_cash_register_session(${q(s.id)},${q(s.deviceId)},jsonb_build_object('countedCashCents',${s.countedCashCents},'countedCardCents',${s.expectedCardCents},'countedInvitationCents',0,'countedOtherCents',0,'finalCashFundCents',10000,'notes',${q(s.notes)}));
      -- These new fixtures are authored in this transaction. The normal close
      -- RPC supplies the economic snapshot; only its synthetic clock is dated.
      update public.cash_sessions set closed_at=${q(s.closedAt)}::timestamptz,
        print_snapshot=jsonb_set(print_snapshot,'{closedAt}',to_jsonb(${q(s.closedAt)}::text)) where id=${q(s.id)} and tenant_id=${q(s.tenantId)};
      if not exists(select 1 from public.cash_sessions where id=${q(s.id)} and expected_cash_cents=${s.expectedCashCents} and expected_card_cents=${s.expectedCardCents} and discrepancy_cents=${s.discrepancy}) then raise exception 'DEMO_HISTORY_CLOSING_TOTALS'; end if;
      if exists(select 1 from public.inventory_consumption_failures f join public.ticket_lines l on l.id=f.ticket_line_id join public.tickets t on t.id=l.ticket_id where t.cash_session_id=${q(s.id)})
        or exists(select 1 from public.sale_auxiliary_failures f join public.ticket_lines l on l.id=f.entity_id join public.tickets t on t.id=l.ticket_id where t.cash_session_id=${q(s.id)}) then raise exception 'DEMO_HISTORY_AUXILIARY_FAILURE'; end if;
    end $history$;
    ${rollback ? 'rollback;' : 'commit;'}`
}

export function historyReportSql(plan) {
  const ids = plan.sessions.map(s => quoteSql(s.id)).join(',')
  return `with seeded as (select * from public.cash_sessions where id in (${ids})), results as (
    select s.tenant_id,s.venue_id,min(s.opened_at) first_open,max(s.closed_at) last_close,count(*) sessions,
      count(*) filter(where s.status='open') open_sessions,sum(s.discrepancy_cents) discrepancy_cents,
      (select count(*) from public.tickets t where t.cash_session_id in (select id from seeded where venue_id=s.venue_id)) tickets,
      (select coalesce(sum(total_cents),0) from public.sales sale where sale.cash_session_id in (select id from seeded where venue_id=s.venue_id)) total_cents
    from seeded s group by s.tenant_id,s.venue_id
  ) select coalesce(json_agg(row_to_json(results)),'[]') from results;`
}

export function historyIntegritySql(plan) {
  const sessions = plan.sessions.map(s => quoteSql(s.id)).join(',')
  return `do $verify$ begin
    if (select count(*) from public.cash_sessions where id in (${sessions}) and status='closed')<>${plan.sessions.length} then raise exception 'DEMO_HISTORY_MISSING_SESSIONS'; end if;
    if exists(select 1 from public.tickets t where t.cash_session_id in (${sessions}) and (
      t.subtotal_cents<>(select coalesce(sum(line_total_cents),0) from public.ticket_lines where ticket_id=t.id)
      or t.total_cents<>(select coalesce(sum(net_total_cents),0) from public.ticket_lines where ticket_id=t.id)
      or coalesce(t.discount_amount_cents,0)<>(select coalesce(sum(discount_amount_cents),0) from public.ticket_lines where ticket_id=t.id)
      or t.total_cents<>(select coalesce(sum(amount_cents),0) from public.sale_payments p join public.sales s on s.id=p.sale_id where s.ticket_id=t.id)
      or t.total_cents<>(select coalesce(sum(total_cents),0) from public.sales where ticket_id=t.id)
      or t.local_created_at>now()
    )) then raise exception 'DEMO_HISTORY_MONEY_OR_DATE_MISMATCH'; end if;
    if exists(select 1 from public.ticket_lines l join public.tickets t on t.id=l.ticket_id where t.cash_session_id in (${sessions}) and (l.taxable_base_cents+l.tax_amount_cents<>l.net_total_cents or l.category_id_snapshot is null or l.category_name_snapshot is null or l.catalog_tab_id_snapshot is null)) then raise exception 'DEMO_HISTORY_SNAPSHOT_MISMATCH'; end if;
    if exists(select 1 from public.cash_sessions cs where cs.id in (${sessions}) and (
      cs.closed_at<cs.opened_at or cs.closed_at>now()
      or cs.expected_cash_cents<>cs.opening_float_cents+(select coalesce(sum(p.amount_cents),0) from public.sale_payments p join public.sales s on s.id=p.sale_id where s.cash_session_id=cs.id and p.method='cash')-(select coalesce(sum(amount_cents),0) from public.cash_movements where cash_session_id=cs.id and direction='exit')
      or cs.expected_card_cents<>(select coalesce(sum(p.amount_cents),0) from public.sale_payments p join public.sales s on s.id=p.sale_id where s.cash_session_id=cs.id and p.method='card')
      or cs.discrepancy_cents<>(cs.counted_cash_cents-cs.expected_cash_cents)+(cs.counted_card_cents-cs.expected_card_cents)
    )) then raise exception 'DEMO_HISTORY_CASH_MISMATCH'; end if;
    if exists(select 1 from public.sale_payments p join public.sales s on s.id=p.sale_id where s.cash_session_id in (${sessions}) and (p.cashlogy_request_id is not null or p.cashlogy_transaction_id is not null))
      or exists(select 1 from public.fiscal_local_records f join public.tickets t on t.id=f.ticket_id where t.cash_session_id in (${sessions})) then raise exception 'DEMO_HISTORY_EXTERNAL_INTEGRATION'; end if;
    if exists(select 1 from public.inventory_stock_levels level where tenant_id=${quoteSql(demoId('grupo'))} and (quantity<0 or quantity<>(select coalesce(sum(stock_quantity_delta),0) from public.inventory_stock_movements m where m.tenant_id=level.tenant_id and m.venue_id=level.venue_id and m.inventory_item_id=level.inventory_item_id and m.warehouse_id=level.warehouse_id))) then raise exception 'DEMO_HISTORY_STOCK_LEDGER_MISMATCH'; end if;
  end $verify$;`
}
