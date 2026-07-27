import { useCallback, useEffect, useRef, useState } from 'react'
import { CrmShell } from '../../features/crm/layout/CrmShell'
import { canAccessCrm, canAccessCrmSection } from '../../features/crm/routing/crmPermissions'
import type { CrmSection } from '../../features/crm/routing/crmNavigation'
import { CrmSectionContent } from '../../features/crm/routing/CrmSectionContent'
import { resolveSelectedVenueId } from '../../features/crm/venues/services/venueSelection'
import { applyCrmOpenCashSalesTotals, loadCrmOpenCashSalesTotals, loadCrmStats, subscribeToCrmStatsChanges } from '../../features/crm/analytics/services/analyticsService'
import { loadCrmVenues } from '../../features/crm/access/services/accessService'
import { useCatalogAdmin } from '../../features/crm/catalog/hooks/useCatalogAdmin.ts'
import type { CrmStats, CrmVenue, TenantContext } from '../../types'
import { getReadableError } from '../../utils/errors'
import './crm.css'

export type CrmPageProps = {
  context: TenantContext
  error: string | null
  isOnline: boolean
  onCatalogChanged: (venueId: string) => Promise<void>
  onError: (error: string | null) => void
  onLogout: () => void
}

export function CrmPage({ context, error, isOnline, onCatalogChanged, onError, onLogout }: CrmPageProps) {
  const [activeSection, setActiveSection] = useState<CrmSection>('dashboard')
  const [isBusy, setIsBusy] = useState(false)
  const [stats, setStats] = useState<CrmStats | null>(null)
  const [venues, setVenues] = useState<CrmVenue[]>([])
  const [selectedVenueId, setSelectedVenueId] = useState('')
  const handleCatalogLoadError = useCallback((loadError: unknown) => onError(getReadableError(loadError)), [onError])
  const { catalog, isLoading: isCatalogLoading, refresh: refreshAdminCatalog } = useCatalogAdmin(selectedVenueId, isOnline, handleCatalogLoadError)

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setIsBusy(true)
    onError(null)
    try {
      await action()
    } catch (actionError) {
      onError(getReadableError(actionError))
    } finally {
      setIsBusy(false)
    }
  }, [onError])

  const refreshCurrentProjectedCatalog = useCallback(async () => {
    if (!selectedVenueId) return
    await onCatalogChanged(selectedVenueId)
  }, [onCatalogChanged, selectedVenueId])

  const mutateCatalog = useCallback(async (action: () => Promise<unknown>) => {
    setIsBusy(true)
    onError(null)
    try {
      await action()
      await Promise.all([refreshAdminCatalog(true), refreshCurrentProjectedCatalog()])
      return true
    } catch (actionError) {
      onError(getReadableError(actionError))
      return false
    } finally {
      setIsBusy(false)
    }
  }, [onError, refreshAdminCatalog, refreshCurrentProjectedCatalog])

  const refreshVenues = useCallback(async () => {
    const nextVenues = await loadCrmVenues(context)
    setVenues(nextVenues)
    setSelectedVenueId((current) => resolveSelectedVenueId(nextVenues, current))
  }, [context])

  useEffect(() => {
    if (isOnline) void runAction(refreshVenues)
  }, [isOnline, refreshVenues, runAction])

  useEffect(() => {
    if (!canAccessCrmSection(context.role, activeSection)) setActiveSection('dashboard')
  }, [activeSection, context.role])

  const refreshStats = useCallback(async (options: { monthKey?: string; silent?: boolean } = {}) => {
    const loadStats = async () => {
      onError(null)
      if (!selectedVenueId) {
        setStats(null)
        return
      }
      const selectedVenue = venues.find((venue) => venue.id === selectedVenueId)
      if (!selectedVenue) {
        setStats(null)
        return
      }
      setStats(await loadCrmStats(context, selectedVenue, options.monthKey))
    }
    if (options.silent) {
      try { await loadStats() } catch (statsError) { onError(getReadableError(statsError)) }
      return
    }
    await runAction(loadStats)
  }, [context, onError, runAction, selectedVenueId, venues])
  const refreshStatsRef = useRef(refreshStats)
  refreshStatsRef.current = refreshStats
  const statsRef = useRef(stats)
  statsRef.current = stats

  useEffect(() => {
    if ((activeSection === 'dashboard' || activeSection === 'stats') && isOnline && selectedVenueId) void refreshStats()
  }, [activeSection, isOnline, refreshStats, selectedVenueId])

  useEffect(() => {
    if (!isOnline || activeSection !== 'dashboard' || !venues.length) return undefined
    let active = true
    let cashSessionTimer: ReturnType<typeof window.setTimeout> | null = null
    let salesTimer: ReturnType<typeof window.setTimeout> | null = null
    let fallbackTimer: ReturnType<typeof window.setInterval> | null = null
    const unavailableVenueIds = new Set<string>()
    const refreshCashSessions = () => {
      if (cashSessionTimer) window.clearTimeout(cashSessionTimer)
      cashSessionTimer = window.setTimeout(() => void refreshStatsRef.current({ silent: true }), 250)
    }
    const refreshOpenCashSales = async () => {
      const cashSessionIds = statsRef.current?.openCashSessions.map((session) => session.id) ?? []
      if (!cashSessionIds.length) return
      try {
        const totals = await loadCrmOpenCashSalesTotals(context, cashSessionIds)
        if (active) setStats((current) => applyCrmOpenCashSalesTotals(current, totals))
      } catch (salesError) {
        if (active) onError(getReadableError(salesError))
      }
    }
    const scheduleSalesRefresh = () => {
      if (salesTimer) window.clearTimeout(salesTimer)
      salesTimer = window.setTimeout(() => void refreshOpenCashSales(), 250)
    }
    const unsubscribers = venues.map((venue) => subscribeToCrmStatsChanges(
      context,
      venue.id,
      refreshCashSessions,
      scheduleSalesRefresh,
      (status, channelError) => {
        if (status === 'SUBSCRIBED') {
          unavailableVenueIds.delete(venue.id)
          if (!unavailableVenueIds.size && fallbackTimer) {
            window.clearInterval(fallbackTimer)
            fallbackTimer = null
          }
          scheduleSalesRefresh()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          unavailableVenueIds.add(venue.id)
          console.warn(`Realtime del dashboard CRM no disponible para ${venue.name}.`, channelError)
          if (!fallbackTimer) fallbackTimer = window.setInterval(scheduleSalesRefresh, 3000)
        }
      },
    ))
    return () => {
      active = false
      if (cashSessionTimer) window.clearTimeout(cashSessionTimer)
      if (salesTimer) window.clearTimeout(salesTimer)
      if (fallbackTimer) window.clearInterval(fallbackTimer)
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [activeSection, context, isOnline, onError, venues])

  if (!canAccessCrm(context.role)) return null
  const disabled = !isOnline || isBusy || isCatalogLoading

  return <CrmShell activeSection={activeSection} context={context} disabled={disabled} error={error} isOnline={isOnline} onLogout={onLogout} onSectionChange={(section) => {
    if (canAccessCrmSection(context.role, section)) setActiveSection(section)
  }} onVenueChange={(venueId) => {
    setStats(null)
    setSelectedVenueId(venueId)
  }} selectedVenueId={selectedVenueId} venues={venues}>
    <CrmSectionContent activeSection={activeSection} catalog={catalog} context={context} disabled={disabled} isCatalogLoading={isCatalogLoading} mutateCatalog={mutateCatalog} onCatalogChanged={refreshCurrentProjectedCatalog} onError={onError} onStatsRefresh={refreshStats} onVenuesChanged={refreshVenues} runAction={runAction} selectedVenueId={selectedVenueId} stats={stats} venues={venues} />
  </CrmShell>
}
