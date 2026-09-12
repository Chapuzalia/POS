import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import {
  getVisibleTicketPages,
  SESSION_TICKETS_PAGE_SIZE,
} from '../src/features/cash-registers/services/sessionTicketHistoryModel.ts'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const migration = await readFile(
  new URL('../supabase/migrations/20260912222539_paginate_pos_session_tickets.sql', import.meta.url),
  'utf8',
)

async function ticketHistoryDatabase() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.tickets (
      id uuid primary key,
      tenant_id uuid not null,
      cash_session_id uuid not null,
      local_created_at timestamptz not null,
      total_cents integer not null
    );
    create table public.sales (id uuid primary key, ticket_id uuid not null);
    create table public.ticket_lines (
      id uuid primary key,
      ticket_id uuid not null,
      product_name text not null,
      variant_name text not null
    );
    create table public.ticket_line_components (
      ticket_line_id uuid not null,
      product_name_snapshot text not null,
      variant_name_snapshot text not null
    );
    create table public.offline_event_log (
      tenant_id uuid not null,
      event_kind text not null,
      payload jsonb not null
    );
    create function public.crm_normalize_search_text(value text)
    returns text language sql immutable set search_path = '' as $$
      select lower(translate(coalesce(value, ''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'));
    $$;
  `)
  await db.exec(migration)
  return db
}

test('the migration satisfies the repository deployment-safety policy', () => {
  assert.deepEqual(analyzeMigration(migration), [])
})

test('the database filters before returning pages of at most 12 ticket IDs', async (context) => {
  const db = await ticketHistoryDatabase()
  context.after(() => db.close())
  const tenantId = '10000000-0000-0000-0000-000000000001'
  const sessionId = '20000000-0000-0000-0000-000000000001'

  for (let index = 1; index <= 25; index += 1) {
    const ticketId = `30000000-0000-0000-0000-${String(index).padStart(12, '0')}`
    const lineId = `40000000-0000-0000-0000-${String(index).padStart(12, '0')}`
    await db.query(
      'insert into public.tickets values ($1, $2, $3, $4, $5)',
      [ticketId, tenantId, sessionId, new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(), 1000 + index * 25],
    )
    await db.query(
      "insert into public.ticket_lines values ($1, $2, $3, 'Normal')",
      [lineId, ticketId, `Café especial ${index}`],
    )
  }

  const firstPage = await db.query(
    'select * from public.pos_session_ticket_page($1, $2, null, 1)',
    [tenantId, sessionId],
  )
  const secondPage = await db.query(
    'select * from public.pos_session_ticket_page($1, $2, null, 2)',
    [tenantId, sessionId],
  )
  const lastPage = await db.query(
    'select * from public.pos_session_ticket_page($1, $2, null, 3)',
    [tenantId, sessionId],
  )
  const productMatch = await db.query(
    'select * from public.pos_session_ticket_page($1, $2, $3, 1)',
    [tenantId, sessionId, 'cafe especial 7'],
  )
  const firstProductMatches = await db.query(
    'select * from public.pos_session_ticket_page($1, $2, $3, 1)',
    [tenantId, sessionId, 'cafe especial'],
  )
  const amountMatch = await db.query(
    'select * from public.pos_session_ticket_page($1, $2, $3, 1)',
    [tenantId, sessionId, '11,75'],
  )

  assert.equal(SESSION_TICKETS_PAGE_SIZE, 12)
  assert.equal(firstPage.rows.length, 12)
  assert.equal(secondPage.rows.length, 12)
  assert.equal(lastPage.rows.length, 1)
  assert.equal(Number(firstPage.rows[0].total_count), 25)
  assert.deepEqual(firstPage.rows.map((row) => Number(row.ticket_number)), [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14])
  assert.equal(productMatch.rows.length, 1)
  assert.equal(Number(productMatch.rows[0].ticket_number), 7)
  assert.equal(firstProductMatches.rows.length, 12)
  assert.equal(Number(firstProductMatches.rows[0].total_count), 25)
  assert.deepEqual(firstProductMatches.rows.map((row) => Number(row.ticket_number)), [25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14])
  assert.equal(amountMatch.rows.length, 1)
  assert.equal(Number(amountMatch.rows[0].ticket_number), 7)
})

test('the POS loads only the IDs and nested detail belonging to the requested page', async () => {
  const [service, modal] = await Promise.all([
    readFile(new URL('../src/services/posService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/modals/SessionTicketsModal.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(service, /rpc\('pos_session_ticket_page'/)
  assert.match(service, /\.slice\(0, SESSION_TICKETS_PAGE_SIZE\)/)
  assert.match(service, /ticketQuery = ticketQuery\.in\('id', ticketIds\)/)
  assert.match(service, /eventQuery = eventQuery\.in\('payload->ticket->>id', ticketIds\)/)
  assert.match(modal, /loadPage\(currentPage, requestedQuery\)/)
  assert.doesNotMatch(modal, /filterSessionTickets|\.slice\(/)
  assert.match(migration, /limit 12\s+offset/i)
})

test('the ticket pagination exposes at most five nearby page buttons', () => {
  assert.deepEqual(getVisibleTicketPages(1, 120), [1, 2, 3, 4, 5])
  assert.deepEqual(getVisibleTicketPages(6, 120), [4, 5, 6, 7, 8])
  assert.deepEqual(getVisibleTicketPages(10, 120), [6, 7, 8, 9, 10])
})
