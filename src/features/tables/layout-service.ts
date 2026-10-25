import { supabase } from '../../lib/supabase'
import type { TenantContext } from '../../types/domain'
import { getReadableError } from '../../utils/errors'
import { compactJoinedCompositions } from './joined-layout'
import type { RestaurantMap, VenueTableLayout, TableLayoutEntry } from './types'

function client() { if (!supabase) throw new Error('Supabase no está configurado.'); return supabase }

export async function loadVenueTableLayout(context: TenantContext): Promise<VenueTableLayout> {
  const { data, error } = await client().rpc('get_venue_table_layout', { p_venue_id: context.venueId })
  if (error) throw error
  const value = data as VenueTableLayout
  if (!value || value.venueId !== context.venueId) throw new Error('No se pudo cargar la distribución de mesas del local.')
  return value
}

export async function saveVenueTableLayout(context: TenantContext, expectedRevision: number, tables: Record<string, TableLayoutEntry>): Promise<VenueTableLayout> {
  const { data, error } = await client().rpc('save_venue_table_layout', { p_venue_id: context.venueId, p_expected_revision: expectedRevision, p_tables: tables })
  if (error) throw new Error(getReadableError(error, { operation: 'features.tables.layout-service' }))
  return data as VenueTableLayout
}

export function applyVenueLayout(map: RestaurantMap, layout: VenueTableLayout): RestaurantMap {
  const groupMembers = new Map<string, string[]>()
  for (const [tableId, entry] of Object.entries(layout.tables)) {
    if (entry.groupId) groupMembers.set(entry.groupId, [...(groupMembers.get(entry.groupId) ?? []), tableId])
  }
  return {
    ...map,
    layoutRevision: layout.revision,
    tables: compactJoinedCompositions(map.tables.map((table) => {
      const entry = layout.tables[table.id]
      return {
        ...table,
        positionX: entry?.positionX ?? table.positionX,
        positionY: entry?.positionY ?? table.positionY,
        layoutGroupId: entry?.groupId ?? null,
        layoutGroupTableIds: entry?.groupId ? (groupMembers.get(entry.groupId) ?? [table.id]) : [],
      }
    })),
  }
}

export function layoutFromMap(map: RestaurantMap): Record<string, TableLayoutEntry> {
  return Object.fromEntries(map.tables.map((table) => [table.id, { positionX: table.positionX, positionY: table.positionY, groupId: table.layoutGroupId ?? null }]))
}

export function subscribeToVenueTableLayout(context: TenantContext, onChange: (revision: number) => void) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`venue-table-layout:${context.tenantId}:${context.venueId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'venue_table_layouts', filter: `venue_id=eq.${context.venueId}` }, (payload) => {
      const revision = Number((payload.new as { revision?: number } | null)?.revision ?? 0)
      onChange(revision)
    })
    .subscribe()
  return () => { void supabase?.removeChannel(channel) }
}
