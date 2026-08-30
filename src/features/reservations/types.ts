import type { DiningArea, RestaurantMap, RestaurantTable } from '../tables/types'

export type ReservationStatus =
  | 'confirmed'
  | 'arrived'
  | 'seated'
  | 'completed'
  | 'cancelled'
  | 'no_show'

export type ReservationTable = {
  id: string
  name: string
  capacity: number
  areaId: string
  areaName: string
  sortOrder: number
  isActive: boolean
}

export type Reservation = {
  id: string
  tenantId: string
  venueId: string
  customerName: string
  customerPhone: string
  customerEmail: string | null
  partySize: number
  startsAt: string
  endsAt: string
  status: ReservationStatus
  notes: string | null
  cancellationReason: string | null
  orderId: string | null
  tableIds: string[]
  tables: ReservationTable[]
  arrivedAt: string | null
  seatedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
  updatedAt: string
}

export type ReservationDraft = {
  id?: string
  customerName: string
  customerPhone: string
  customerEmail: string | null
  partySize: number
  startsAt: string
  endsAt: string
  notes: string | null
  tableIds: string[]
  expectedUpdatedAt?: string
}

export type ReservationConflict = {
  reservationId: string
  customerName: string
  startsAt: string
  endsAt: string
  tableId: string
  tableName: string
}

export type SaveReservationResult = {
  reservation: Reservation
  conflicts: ReservationConflict[]
}

export type ReservationAvailability = 'available' | 'insufficient' | 'conflict' | 'inactive'

export type ReservationTableOption = ReservationTable & {
  availability: ReservationAvailability
  conflicts: ReservationConflict[]
}

export type ReservationsView = 'list' | 'timeline' | 'map'

export type ReservationEditorState = {
  reservation: Reservation | null
  preselectedTableIds: string[]
  preselectedStartsAt?: string
}

export type ReservationMap = {
  areas: DiningArea[]
  tables: RestaurantTable[]
  operationalMap: RestaurantMap | null
}

export type ReservationSummary = {
  upcoming: number
  arrived: number
  late: number
  unassigned: number
}

export type ReservationsController = {
  canManage: boolean
  checkAvailability: (startsAt: string, endsAt: string, reservationId?: string) => Promise<ReservationConflict[]>
  close: () => void
  conflicts: ReservationConflict[]
  date: string
  detail: Reservation | null
  editor: ReservationEditorState | null
  isLoading: boolean
  isOpen: boolean
  loadReservations: (date: string) => Promise<Reservation[]>
  map: ReservationMap
  open: () => void
  openReservation: (reservationId: string) => Promise<void>
  openCreate: (tableIds?: string[], startsAt?: string) => void
  openDetail: (reservation: Reservation) => void
  openEdit: (reservation: Reservation) => void
  pendingConflictDraft: ReservationDraft | null
  query: string
  reservations: Reservation[]
  save: (draft: ReservationDraft, allowConflict?: boolean) => Promise<boolean>
  searchResults: Reservation[]
  selectedTableIds: string[]
  setDate: (date: string) => void
  setDetail: (reservation: Reservation | null) => void
  setEditor: (editor: ReservationEditorState | null) => void
  setQuery: (query: string) => void
  setSelectedTableIds: (tableIds: string[]) => void
  setView: (view: ReservationsView) => void
  summary: ReservationSummary
  timeZone: string
  today: string
  updateStatus: (reservation: Reservation, status: ReservationStatus, reason?: string) => Promise<void>
  seat: (reservation: Reservation, tableIds?: string[]) => Promise<string | null>
  refresh: () => Promise<void>
  view: ReservationsView
}
