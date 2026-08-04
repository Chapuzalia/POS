import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

test('las ventas pueden insertar lineas antes de repartir el descuento', async () => {
  const [discountMigration, fixMigration, consolidated] = await Promise.all([
    readFile(new URL('../supabase/migrations/20260802120000_add_discount_promotions.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260803190000_fix_ticket_line_discount_defaults.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
  ])

  assert.match(discountMigration, /alter table public\.ticket_lines alter column net_total_cents set not null/i)
  assert.match(fixMigration, /new\.net_total_cents := coalesce\([\s\S]*new\.line_total_cents - new\.discount_amount_cents/i)
  assert.match(fixMigration, /before insert on public\.ticket_lines/i)
  assert.match(fixMigration, /for each row execute function public\.set_ticket_line_discount_defaults\(\)/i)
  assert.match(consolidated, /create trigger set_ticket_line_discount_defaults_trigger[\s\S]*before insert on public\.ticket_lines/i)
})
