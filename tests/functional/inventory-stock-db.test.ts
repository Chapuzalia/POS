import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const migration = await readFile(new URL('../../supabase/migrations/20261028125520_inventory_stock_control_and_manual_audit.sql', import.meta.url), 'utf8')
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const tenant = id(1), venue = id(2), item = id(3), warehouse = id(4), unit = id(5), otherVenue = id(6), otherWarehouse = id(7)
let db: PGlite

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create function public.user_is_tenant_admin(uuid) returns boolean language sql as $$ select $1 = '${tenant}' and auth.uid() = '${id(10)}'::uuid $$;
    create function public.user_has_venue_access(uuid, uuid) returns boolean language sql as $$ select $1 = '${tenant}' and $2 = '${venue}' and auth.uid() = '${id(10)}'::uuid $$;
    create table public.venues (id uuid primary key, tenant_id uuid, timezone text, day_change_time time);
    create table public.inventory_items (id uuid primary key, tenant_id uuid, venue_id uuid, base_unit_id uuid);
    create table public.inventory_warehouses (id uuid primary key, tenant_id uuid, venue_id uuid);
    create table public.inventory_stock_levels (warehouse_id uuid, inventory_item_id uuid, tenant_id uuid, venue_id uuid,
      quantity numeric(18,6), is_enabled boolean, target_quantity numeric, updated_at timestamptz default now(), primary key(warehouse_id, inventory_item_id));
    create table public.inventory_stock_movements (id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid,
      inventory_item_id uuid, warehouse_id uuid, unit_id uuid, source_type text, source_id uuid, ticket_line_id uuid, production_id uuid,
      stock_quantity_before numeric, stock_quantity_delta numeric, stock_quantity_after numeric, metadata jsonb default '{}'::jsonb,
      created_at timestamptz default now(), check (stock_quantity_delta <> 0 and stock_quantity_before + stock_quantity_delta = stock_quantity_after));
    create table public.inventory_consumption_failures (tenant_id uuid, venue_id uuid, created_at timestamptz);
    alter table public.inventory_stock_movements enable row level security;
    alter table public.inventory_consumption_failures enable row level security;
    alter table public.inventory_items enable row level security;
    alter table public.venues enable row level security;
    create policy movements_read on public.inventory_stock_movements for select to authenticated using (tenant_id = '${tenant}' and venue_id = '${venue}');
    create policy failures_read on public.inventory_consumption_failures for select to authenticated using (tenant_id = '${tenant}' and venue_id = '${venue}');
    create policy items_read on public.inventory_items for select to authenticated using (tenant_id = '${tenant}' and venue_id = '${venue}');
    create policy venues_read on public.venues for select to authenticated using (tenant_id = '${tenant}' and id = '${venue}');
    grant usage on schema auth to authenticated;
    grant select on public.venues, public.inventory_items, public.inventory_stock_movements, public.inventory_consumption_failures to authenticated;
    select set_config('test.uid', '${id(10)}', false);
    insert into public.venues values ('${venue}', '${tenant}', 'Europe/Madrid', '04:00'), ('${otherVenue}', '${id(99)}', 'Europe/Madrid', '04:00');
    insert into public.inventory_items values ('${item}', '${tenant}', '${venue}', '${unit}');
    insert into public.inventory_warehouses values ('${warehouse}', '${tenant}', '${venue}'), ('${otherWarehouse}', '${id(99)}', '${otherVenue}');
    insert into public.inventory_stock_levels values ('${warehouse}', '${item}', '${tenant}', '${venue}', 10, true, 24, now());
  `)
  await db.exec(migration)
})
afterEach(async () => { await db.close() })

const update = (levels: unknown[], tenantId = tenant, venueId = venue) => db.query('select public.update_inventory_item_stock($1,$2,$3,$4::jsonb)', [tenantId, venueId, item, JSON.stringify(levels)])
const stock = async () => Number((await db.query<{ quantity: string }>('select quantity from public.inventory_stock_levels where warehouse_id=$1', [warehouse])).rows[0].quantity)
const report = async (start = '2026-10-19T02:00:00Z', end = '2026-10-28T03:00:00Z', tenantId = tenant, venueId = venue) => (await db.query<{ result: { daily: Array<{ day: string; quantity: number }>; failureCount: number; incompatibleCount: number } }>('select public.inventory_item_consumption_report($1,$2,$3,$4,$5,null) as result', [tenantId, venueId, item, start, end])).rows[0].result

describe('audited manual stock operations', () => {
  it('adds against the current database balance, preserves targets and deduplicates retries', async () => {
    await db.exec('set role authenticated')
    const request = [{ warehouseId: warehouse, enabled: true, quantity: 2.125, mode: 'add', requestId: 'request-1', expectedQuantity: 999 }]
    await update(request)
    await update(request)
    await db.exec('reset role')
    expect(await stock()).toBe(12.125)
    expect((await db.query('select target_quantity from public.inventory_stock_levels')).rows[0].target_quantity).toBe('24')
    const ledger = (await db.query('select * from public.inventory_stock_movements')).rows
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ stock_quantity_before: '10.000000', stock_quantity_delta: '2.125000', stock_quantity_after: '12.125000', source_type: 'manual_adjustment', unit_id: unit })
    await db.exec('update public.inventory_stock_levels set quantity = quantity - 3')
    await update([{ ...request[0], quantity: 1, requestId: 'request-2' }])
    expect(await stock()).toBe(10.125)
  })
  it('rejects stale absolute totals without changing stock, and supports negative totals', async () => {
    await expect(update([{ warehouseId: warehouse, quantity: 7, mode: 'set', expectedQuantity: 12 }])).rejects.toThrow('INVENTORY_STOCK_CHANGED')
    expect(await stock()).toBe(10)
    await update([{ warehouseId: warehouse, quantity: -0.125, mode: 'set', expectedQuantity: 10 }])
    expect(await stock()).toBe(-0.125)
  })
  it('keeps old clients compatible and avoids movements for unchanged quantities', async () => {
    await db.query('select public.set_inventory_item_stock($1,$2,$3,$4::jsonb)', [tenant, venue, item, JSON.stringify([{ warehouseId: warehouse, quantity: 6, enabled: true }])])
    await update([{ warehouseId: warehouse, quantity: 6 }])
    expect(await stock()).toBe(6)
    expect((await db.query('select * from public.inventory_stock_movements')).rows).toHaveLength(1)
  })
  it('rolls back a whole multi-warehouse edit on invalid scope or an audit failure', async () => {
    await expect(update([{ warehouseId: warehouse, quantity: 1, mode: 'add' }, { warehouseId: otherWarehouse, quantity: 1, mode: 'add' }])).rejects.toThrow('INVENTORY_WAREHOUSE_NOT_FOUND')
    expect(await stock()).toBe(10)
    await db.exec('alter table public.inventory_stock_movements add constraint reject_audit check (false)')
    await expect(update([{ warehouseId: warehouse, quantity: 1, mode: 'add' }])).rejects.toThrow()
    expect(await stock()).toBe(10)
  })
  it('rejects duplicate warehouses, invalid additions and foreign tenants/venues', async () => {
    await expect(update([{ warehouseId: warehouse, quantity: 2 }, { warehouseId: warehouse, quantity: 3 }])).rejects.toThrow('INVENTORY_INVALID_LEVELS')
    await expect(update([{ warehouseId: warehouse, quantity: -1, mode: 'add' }])).rejects.toThrow('INVENTORY_INVALID_QUANTITY')
    await expect(update([{ warehouseId: warehouse, quantity: 'NaN' }])).rejects.toThrow('INVENTORY_INVALID_QUANTITY')
    await expect(update([], id(99))).rejects.toThrow('INVENTORY_FORBIDDEN')
    await expect(update([], tenant, otherVenue)).rejects.toThrow('INVENTORY_ITEM_NOT_FOUND')
    await db.exec('set role anon')
    await expect(update([])).rejects.toThrow('permission denied')
  })
})

describe('bounded consumption report', () => {
  it('counts physical sales only, respects the operational day, and discloses failures and changed units', async () => {
    const movement = async (source: string, delta: number, timestamp: string, unitId = unit, ticketLineId: string | null = id(30)) => db.query(`insert into public.inventory_stock_movements(tenant_id,venue_id,inventory_item_id,warehouse_id,unit_id,source_type,ticket_line_id,stock_quantity_before,stock_quantity_delta,stock_quantity_after,created_at) values ($1,$2,$3,$4,$5,$6,$7,10,$8::numeric,10+$8::numeric,$9)`, [tenant, venue, item, warehouse, unitId, source, ticketLineId, delta, timestamp])
    await movement('sale_aggregate', -6, '2026-10-27T02:30:00Z') // before 04:00 local -> previous operational day
    await movement('product', -2, '2026-10-27T04:30:00Z')
    await movement('manual_adjustment', -5, '2026-10-27T04:30:00Z')
    await movement('production_ingredient', -3, '2026-10-27T04:30:00Z')
    await movement('supplier_document_receipt', 10, '2026-10-27T04:30:00Z')
    await movement('product', -100, '2026-10-27T04:30:00Z', id(55))
    await movement('sale_aggregate', -20, '2026-10-27T04:30:00Z', unit, null)
    await db.exec(`insert into public.inventory_consumption_failures values ('${tenant}','${venue}','2026-10-27T04:30:00Z'), ('${id(99)}','${otherVenue}','2026-10-27T04:30:00Z'); set role authenticated;`)
    expect(await report()).toEqual({ daily: [{ day: '2026-10-26', quantity: 6 }, { day: '2026-10-27', quantity: 2 }], failureCount: 1, incompatibleCount: 1 })
    expect((await db.query('select * from public.inventory_consumption_failures')).rows).toHaveLength(1)
    await expect(report('2026-01-01', '2026-10-28')).rejects.toThrow('INVENTORY_INVALID_PERIOD')
    await expect(report(undefined, undefined, id(99), otherVenue)).rejects.toThrow('INVENTORY_FORBIDDEN')
    await expect(report(undefined, undefined, tenant, otherVenue)).rejects.toThrow('INVENTORY_ITEM_NOT_FOUND')
    await db.exec('reset role; set role anon')
    await expect(report()).rejects.toThrow('permission denied')
  })
})
