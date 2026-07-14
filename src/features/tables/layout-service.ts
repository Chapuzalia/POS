import { supabase } from '../../lib/supabase'
import type { TenantContext } from '../../types/domain'
import type { RestaurantMap, SessionTableLayout, TableLayoutEntry } from './types'

function client() { if (!supabase) throw new Error('Supabase no esta configurado.'); return supabase }

export async function loadSessionTableLayout(_context: TenantContext, cashSessionId: string): Promise<SessionTableLayout> {
  const { data, error } = await client().rpc('get_cash_session_table_layout', { p_cash_session_id: cashSessionId })
  if (error) throw error
  const value = data as SessionTableLayout
  if (!value || value.cashSessionId !== cashSessionId) throw new Error('No se pudo cargar la distribucion temporal de mesas.')
  return value
}

export async function saveSessionTableLayout(cashSessionId: string, expectedRevision: number, tables: Record<string, TableLayoutEntry>): Promise<SessionTableLayout> {
  const { data, error } = await client().rpc('save_cash_session_table_layout', { p_cash_session_id: cashSessionId, p_expected_revision: expectedRevision, p_tables: tables })
  if (error) throw error
  return data as SessionTableLayout
}

export function applySessionLayout(map: RestaurantMap, layout: SessionTableLayout): RestaurantMap {
  const groupMembers = new Map<string, string[]>()
  for (const [tableId, entry] of Object.entries(layout.tables)) {
    if (entry.groupId) groupMembers.set(entry.groupId, [...(groupMembers.get(entry.groupId) ?? []), tableId])
  }
  return {
    ...map,
    layoutRevision: layout.revision,
    tables: map.tables.map((table) => {
      const entry = layout.tables[table.id]
      return {
        ...table,
        positionX: entry?.positionX ?? table.positionX,
        positionY: entry?.positionY ?? table.positionY,
        layoutGroupId: entry?.groupId ?? null,
        layoutGroupTableIds: entry?.groupId ? (groupMembers.get(entry.groupId) ?? [table.id]) : [],
      }
    }),
  }
}

export function layoutFromMap(map: RestaurantMap): Record<string, TableLayoutEntry> {
  return Object.fromEntries(map.tables.map((table) => [table.id, { positionX: table.positionX, positionY: table.positionY, groupId: table.layoutGroupId ?? null }]))
}

export function subscribeToSessionTableLayout(context: TenantContext, cashSessionId: string, onChange: (revision: number) => void) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`cash-session-layout:${context.tenantId}:${context.venueId}:${cashSessionId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_session_table_layouts', filter: `cash_session_id=eq.${cashSessionId}` }, (payload) => {
      const revision = Number((payload.new as { revision?: number } | null)?.revision ?? 0)
      onChange(revision)
    })
    .subscribe()
  return () => { void supabase?.removeChannel(channel) }
}
