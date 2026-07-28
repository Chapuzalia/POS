import { supabase } from '../../../lib/supabase'
import type { TenantContext } from '../../../types'
import type {
  Reservation,
  ReservationConflict,
  ReservationDraft,
  ReservationStatus,
  ReservationTable,
  SaveReservationResult,
} from '../types'
import { getDateRange, normalizeReservationSearch } from '../domain/reservationAvailability'

type ReservationRow = {
  id: string
  tenant_id: string
  venue_id: string
  customer_name: string
  customer_phone: string
  customer_email: string | null
  party_size: number
  starts_at: string
  ends_at: string
  status: ReservationStatus
  notes: string | null
  cancellation_reason: string | null
  order_id: string | null
  arrived_at: string | null
  seated_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
  reservation_tables?: Array<{
    table_id: string
    restaurant_tables?: {
      id: string
      name: string
      capacity: number
      area_id: string
      sort_order: number
      is_active: boolean
      dining_areas?: { name: string } | null
    } | null
  }>
}

const reservationColumns = `
  id, tenant_id, venue_id, customer_name, customer_phone, customer_email, party_size,
  starts_at, ends_at, status, notes, cancellation_reason, order_id, arrived_at, seated_at,
  completed_at, cancelled_at, created_at, updated_at,
  reservation_tables(
    table_id,
    restaurant_tables(id, name, capacity, area_id, sort_order, is_active, dining_areas(name))
  )
`

function requireSupabase() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

function mapTable(row: NonNullable<NonNullable<ReservationRow['reservation_tables']>[number]['restaurant_tables']>): ReservationTable {
  return {
    id: row.id,
    name: row.name,
    capacity: Number(row.capacity),
    areaId: row.area_id,
    areaName: row.dining_areas?.name ?? 'Sin zona',
    sortOrder: Number(row.sort_order),
    isActive: row.is_active,
  }
}

export function mapReservation(value: unknown): Reservation {
  const row = value as ReservationRow
  const tables = (row.reservation_tables ?? [])
    .map((assignment) => assignment.restaurant_tables)
    .filter((table): table is NonNullable<typeof table> => Boolean(table))
    .map(mapTable)
    .sort((first, second) => first.sortOrder - second.sortOrder)
  return {
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerEmail: row.customer_email,
    partySize: Number(row.party_size),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    notes: row.notes,
    cancellationReason: row.cancellation_reason,
    orderId: row.order_id,
    tableIds: tables.map((table) => table.id),
    tables,
    arrivedAt: row.arrived_at,
    seatedAt: row.seated_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function loadReservationVenueSettings(context: TenantContext) {
  const { data, error } = await requireSupabase().from('venues')
    .select('timezone')
    .eq('tenant_id', context.tenantId)
    .eq('id', context.venueId)
    .single<{ timezone: string }>()
  if (error) throw error
  return { timeZone: data.timezone }
}

export async function loadReservationsForDate(context: TenantContext, dateKey: string, timeZone: string) {
  const { from, to } = getDateRange(dateKey, timeZone)
  const { data, error } = await requireSupabase().from('reservations')
    .select(reservationColumns)
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', context.venueId)
    .gte('starts_at', from)
    .lt('starts_at', to)
    .order('starts_at')
  if (error) throw error
  return (data ?? []).map(mapReservation)
}

export async function loadReservation(context: TenantContext, reservationId: string) {
  const { data, error } = await requireSupabase().from('reservations')
    .select(reservationColumns)
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', context.venueId)
    .eq('id', reservationId)
    .single()
  if (error) throw error
  return mapReservation(data)
}

export async function searchReservations(context: TenantContext, query: string) {
  const normalized = normalizeReservationSearch(query)
  if (!normalized) return []
  const { data, error } = await requireSupabase().rpc('search_reservations', {
    p_venue_id: context.venueId,
    p_query: query,
    p_limit: 200,
  })
  if (error) throw error
  return ((data ?? []) as unknown[]).map(mapReservation)
}

export async function loadReservationTables(context: TenantContext): Promise<ReservationTable[]> {
  const { data, error } = await requireSupabase().from('restaurant_tables')
    .select('id, name, capacity, area_id, sort_order, is_active, dining_areas(name)')
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', context.venueId)
    .order('sort_order')
  if (error) throw error
  return (data ?? []).map((value) => {
    const row = value as unknown as {
      id: string
      name: string
      capacity: number
      area_id: string
      sort_order: number
      is_active: boolean
      dining_areas?: { name: string } | null
    }
    return mapTable(row)
  })
}

export class ReservationConflictError extends Error {
  conflicts: ReservationConflict[]

  constructor(conflicts: ReservationConflict[]) {
    super('RESERVATION_CONFLICT')
    this.name = 'ReservationConflictError'
    this.conflicts = conflicts
  }
}

function readConflictDetail(error: { message?: string; details?: string | null }) {
  if (!`${error.message ?? ''} ${error.details ?? ''}`.includes('RESERVATION_CONFLICT')) return null
  try {
    const parsed = JSON.parse(error.details ?? '{}') as { conflicts?: ReservationConflict[] }
    return parsed.conflicts ?? []
  } catch {
    return []
  }
}

export async function saveReservation(
  context: TenantContext,
  draft: ReservationDraft,
  allowConflict = false,
): Promise<SaveReservationResult> {
  const { data, error } = await requireSupabase().rpc('save_reservation', {
    p_reservation_id: draft.id ?? null,
    p_venue_id: context.venueId,
    p_customer_name: draft.customerName,
    p_customer_phone: draft.customerPhone,
    p_customer_email: draft.customerEmail,
    p_party_size: draft.partySize,
    p_starts_at: draft.startsAt,
    p_ends_at: draft.endsAt,
    p_notes: draft.notes,
    p_table_ids: draft.tableIds,
    p_allow_conflict: allowConflict,
    p_expected_updated_at: draft.expectedUpdatedAt ?? null,
  })
  if (error) {
    const conflicts = readConflictDetail(error)
    if (conflicts) throw new ReservationConflictError(conflicts)
    throw error
  }
  const result = data as { reservation: unknown; conflicts?: ReservationConflict[] }
  return { reservation: mapReservation(result.reservation), conflicts: result.conflicts ?? [] }
}

export async function changeReservationStatus(
  reservationId: string,
  status: ReservationStatus,
  reason: string | null = null,
) {
  const { data, error } = await requireSupabase().rpc('change_reservation_status', {
    p_reservation_id: reservationId,
    p_status: status,
    p_reason: reason,
  })
  if (error) throw error
  return mapReservation((data as { reservation: unknown }).reservation)
}

export async function seatReservation(
  reservationId: string,
  cashSessionId: string,
  deviceId: string,
  tableIds: string[] | null = null,
) {
  const { data, error } = await requireSupabase().rpc('seat_reservation', {
    p_reservation_id: reservationId,
    p_cash_session_id: cashSessionId,
    p_device_id: deviceId,
    p_table_ids: tableIds,
  })
  if (error) throw error
  return String(data)
}

export function subscribeToReservations(
  context: TenantContext,
  onChange: () => void,
  onStatus?: (status: string, error?: Error) => void,
) {
  if (!supabase) return () => undefined
  const channel = supabase.channel(`reservations:${context.tenantId}:${context.venueId}`)
  for (const table of ['reservations', 'reservation_tables'] as const) {
    channel.on('postgres_changes', {
      event: '*',
      schema: 'public',
      table,
      filter: `venue_id=eq.${context.venueId}`,
    }, onChange)
  }
  channel.subscribe((status, error) => onStatus?.(status, error))
  return () => { void supabase?.removeChannel(channel) }
}
