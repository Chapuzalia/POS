import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { sileo } from 'sileo'
import type { CashSession, TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { loadRestaurantMap } from '../../tables/service'
import type { RestaurantMap } from '../../tables/types'
import { localDateKey, normalizePhoneSearch, normalizeReservationSearch, reconcileReservationDetail, sortReservations } from '../domain/reservationAvailability'
import { isReservationLate } from '../domain/reservationStatus'
import {
  changeReservationStatus,
  loadReservation,
  loadReservationsForDate,
  loadReservationVenueSettings,
  ReservationConflictError,
  saveReservation,
  searchReservations,
  seatReservation,
} from '../services/reservationService'
import type {
  Reservation,
  ReservationDraft,
  ReservationEditorState,
  ReservationMap,
  ReservationStatus,
  ReservationsView,
} from '../types'
import { useReservationsRealtime } from './useReservationsRealtime'

type Options = {
  cashSession: CashSession | null
  context: TenantContext | null
  enabled: boolean
  isOnline: boolean
  operationalMap: RestaurantMap
  onError: (message: string | null) => void
  onOpenOrder: (orderId: string) => Promise<void>
  refreshOperationalMap: () => Promise<unknown>
}

const emptyMap: ReservationMap = { areas: [], tables: [], operationalMap: null }

function rankSearchResult(reservation: Reservation, today: string, timeZone: string) {
  const key = localDateKey(new Date(reservation.startsAt), timeZone)
  if (key === today) return 0
  if (key > today) return 1
  return 2
}

export function useReservationsController(options: Options) {
  const [isOpen, setIsOpen] = useState(false)
  const [timeZone, setTimeZone] = useState('UTC')
  const [date, setDate] = useState(() => localDateKey(new Date(), 'UTC'))
  const [view, setView] = useState<ReservationsView>('list')
  const [reservations, setReservations] = useState<Reservation[]>([])
  const [searchResults, setSearchResults] = useState<Reservation[]>([])
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [detail, setDetailState] = useState<Reservation | null>(null)
  const [editor, setEditor] = useState<ReservationEditorState | null>(null)
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([])
  const [conflicts, setConflicts] = useState<ReservationConflictError['conflicts']>([])
  const [pendingConflictDraft, setPendingConflictDraft] = useState<ReservationDraft | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [map, setMap] = useState<ReservationMap>(emptyMap)
  const latestRef = useRef(options)
  latestRef.current = options
  const dateRef = useRef(date)
  dateRef.current = date
  const timeZoneRef = useRef(timeZone)
  timeZoneRef.current = timeZone
  const detailIdRef = useRef<string | null>(detail?.id ?? null)
  detailIdRef.current = detail?.id ?? null
  const refreshSequenceRef = useRef(0)
  const setCurrentDetail = useCallback((reservation: Reservation | null) => {
    detailIdRef.current = reservation?.id ?? null
    setDetailState(reservation)
  }, [])
  const canManage = Boolean(options.context?.canTakeOrders || ['manager', 'owner'].includes(options.context?.role ?? 'cashier'))

  const refresh = useCallback(async (requestedDetailId = detailIdRef.current) => {
    const requestId = ++refreshSequenceRef.current
    const { context, isOnline, operationalMap } = latestRef.current
    if (!context || !isOnline) return
    setIsLoading(true)
    try {
      const selectedDate = dateRef.current
      const previousTimeZone = timeZoneRef.current
      const [settings, baseMap] = await Promise.all([
        loadReservationVenueSettings(context),
        loadRestaurantMap(context),
      ])
      const currentDate = localDateKey(new Date(), settings.timeZone)
      const activeDate = selectedDate === localDateKey(new Date(), previousTimeZone) ? currentDate : selectedDate
      const dayReservations = await loadReservationsForDate(context, activeDate, settings.timeZone)
      const refreshedDetail = requestedDetailId
        ? dayReservations.find((item) => item.id === requestedDetailId)
          ?? await loadReservation(context, requestedDetailId)
        : null
      if (requestId !== refreshSequenceRef.current) return
      timeZoneRef.current = settings.timeZone
      setTimeZone(settings.timeZone)
      if (activeDate !== selectedDate && dateRef.current === selectedDate) {
        dateRef.current = activeDate
        setDate(activeDate)
      }
      setReservations(sortReservations(dayReservations, activeDate === currentDate))
      setMap({
        areas: baseMap.areas,
        tables: baseMap.tables,
        operationalMap: activeDate === currentDate ? operationalMap : null,
      })
      if (requestedDetailId && refreshedDetail) {
        setDetailState((current) => reconcileReservationDetail(current, requestedDetailId, refreshedDetail))
      }
    } catch (error) {
      if (requestId === refreshSequenceRef.current) {
        latestRef.current.onError(getReadableError(error))
      }
    } finally {
      if (requestId === refreshSequenceRef.current) setIsLoading(false)
    }
  }, [])
  useEffect(() => {
    if (!isOpen || !options.isOnline || !latestRef.current.context) return
    void refresh()
  }, [date, isOpen, options.context?.tenantId, options.context?.venueId, options.isOnline, refresh])

  useEffect(() => {
    const normalized = deferredQuery.trim()
    if (!isOpen || !latestRef.current.context || !normalized) {
      setSearchResults([])
      return undefined
    }
    if (!latestRef.current.isOnline) {
      const normalizedText = normalizeReservationSearch(normalized)
      const phone = normalizePhoneSearch(normalized)
      setSearchResults(reservations.filter((reservation) => (
        normalizeReservationSearch(reservation.customerName).includes(normalizedText)
        || (phone.length >= 3 && normalizePhoneSearch(reservation.customerPhone).includes(phone))
        || reservation.tables.some((table) => normalizeReservationSearch(table.name).includes(normalizedText))
      )))
      return undefined
    }
    let active = true
    const timer = window.setTimeout(() => {
      void searchReservations(latestRef.current.context!, normalized).then((results) => {
        if (!active) return
        const today = localDateKey(new Date(), timeZone)
        setSearchResults(results.sort((first, second) => {
          const rank = rankSearchResult(first, today, timeZone) - rankSearchResult(second, today, timeZone)
          return rank || new Date(first.startsAt).getTime() - new Date(second.startsAt).getTime()
        }))
      }).catch((error) => latestRef.current.onError(getReadableError(error)))
    }, 300)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [deferredQuery, isOpen, reservations, timeZone])

  useReservationsRealtime({
    context: options.context,
    enabled: options.enabled,
    isOnline: options.isOnline,
    onRefresh: refresh,
  })

  useEffect(() => {
    if (options.enabled) return
    setIsOpen(false)
    setEditor(null)
    setCurrentDetail(null)
    setQuery('')
  }, [options.enabled, setCurrentDetail])

  const openCreate = useCallback((tableIds: string[] = [], startsAt?: string) => {
    setSelectedTableIds(tableIds)
    setConflicts([])
    setPendingConflictDraft(null)
    setEditor({ reservation: null, preselectedTableIds: tableIds, preselectedStartsAt: startsAt })
  }, [])

  const openEdit = useCallback((reservation: Reservation) => {
    setSelectedTableIds(reservation.tableIds)
    setConflicts([])
    setPendingConflictDraft(null)
    setEditor({ reservation, preselectedTableIds: reservation.tableIds })
  }, [])

  const save = useCallback(async (draft: ReservationDraft, allowConflict = false) => {
    if (!latestRef.current.context || !latestRef.current.isOnline || !canManage) return false
    setIsLoading(true)
    latestRef.current.onError(null)
    try {
      const result = await saveReservation(latestRef.current.context, draft, allowConflict)
      setEditor(null)
      setConflicts([])
      setPendingConflictDraft(null)
      setCurrentDetail(result.reservation)
      await Promise.all([refresh(result.reservation.id), latestRef.current.refreshOperationalMap()])
      sileo.success({ title: draft.id ? 'Reserva actualizada' : 'Reserva creada' })
      return true
    } catch (error) {
      if (error instanceof ReservationConflictError) {
        setConflicts(error.conflicts)
        setPendingConflictDraft(draft)
        return false
      }
      latestRef.current.onError(getReadableError(error))
      return false
    } finally {
      setIsLoading(false)
    }
  }, [canManage, refresh, setCurrentDetail])

  const updateStatus = useCallback(async (
    reservation: Reservation,
    status: ReservationStatus,
    reason?: string,
  ) => {
    if (!latestRef.current.isOnline || !canManage) return
    setIsLoading(true)
    latestRef.current.onError(null)
    try {
      const updated = await changeReservationStatus(reservation.id, status, reason ?? null)
      setCurrentDetail(updated)
      await Promise.all([refresh(updated.id), latestRef.current.refreshOperationalMap()])
      sileo.success({ title: status === 'cancelled' ? 'Reserva cancelada' : 'Reserva actualizada' })
    } catch (error) {
      latestRef.current.onError(getReadableError(error))
    } finally {
      setIsLoading(false)
    }
  }, [canManage, refresh, setCurrentDetail])

  const seat = useCallback(async (reservation: Reservation, tableIds?: string[]) => {
    const { cashSession, context, isOnline } = latestRef.current
    if (!context || !cashSession || !isOnline || !canManage) {
      latestRef.current.onError(cashSession ? 'La gestión de reservas requiere conexión.' : 'Abre una caja para sentar la reserva.')
      return null
    }
    const assigned = tableIds?.length ? tableIds : reservation.tableIds
    if (!assigned.length) {
      openEdit(reservation)
      latestRef.current.onError('Asigna al menos una mesa antes de sentar la reserva.')
      return null
    }
    setIsLoading(true)
    latestRef.current.onError(null)
    try {
      const orderId = await seatReservation(reservation.id, cashSession.id, context.deviceId, tableIds ?? null)
      await Promise.all([refresh(reservation.id), latestRef.current.refreshOperationalMap()])
      setIsOpen(false)
      setCurrentDetail(null)
      await latestRef.current.onOpenOrder(orderId)
      sileo.success({ title: 'Reserva sentada' })
      return orderId
    } catch (error) {
      latestRef.current.onError(getReadableError(error))
      return null
    } finally {
      setIsLoading(false)
    }
  }, [canManage, openEdit, refresh, setCurrentDetail])

  const today = localDateKey(new Date(), timeZone)
  const summary = useMemo(() => {
    const now = new Date()
    return {
      upcoming: reservations.filter((reservation) => (
        reservation.status === 'confirmed' && new Date(reservation.endsAt) > now
      )).length,
      arrived: reservations.filter((reservation) => reservation.status === 'arrived').length,
      late: reservations.filter((reservation) => isReservationLate(reservation, now)).length,
      unassigned: reservations.filter((reservation) => (
        ['confirmed', 'arrived'].includes(reservation.status) && reservation.tableIds.length === 0
      )).length,
    }
  }, [reservations])

  return {
    canManage,
    close: () => {
      setIsOpen(false)
      setEditor(null)
      setCurrentDetail(null)
      setQuery('')
    },
    conflicts,
    date,
    detail,
    editor,
    isLoading,
    isOpen,
    map,
    open: () => {
      setDate(today)
      setIsOpen(true)
    },
    openCreate,
    openDetail: (reservation: Reservation) => setCurrentDetail(reservation),
    openEdit,
    openReservation: async (reservationId: string) => {
      setIsOpen(true)
      const { context, isOnline } = latestRef.current
      if (!context || !isOnline) return
      try { setCurrentDetail(await loadReservation(context, reservationId)) }
      catch (error) { latestRef.current.onError(getReadableError(error)) }
    },
    pendingConflictDraft,
    query,
    refresh,
    reservations,
    save,
    searchResults,
    seat,
    selectedTableIds,
    setDate,
    setDetail: setCurrentDetail,
    setEditor,
    setQuery,
    setSelectedTableIds,
    setView,
    summary,
    timeZone,
    today,
    updateStatus,
    view,
  }
}
