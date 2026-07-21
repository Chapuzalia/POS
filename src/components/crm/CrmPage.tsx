import { useCallback, useEffect, useState } from 'react'
import { CrmShell } from '../../features/crm/layout/CrmShell'
import { canAccessCrm, canAccessCrmSection } from '../../features/crm/routing/crmPermissions'
import type { CrmSection } from '../../features/crm/routing/crmNavigation'
import { CrmSectionContent } from '../../features/crm/routing/CrmSectionContent'
import { resolveSelectedVenueId } from '../../features/crm/venues/services/venueSelection'
import { loadCrmStats, subscribeToCrmStatsChanges } from '../../features/crm/analytics/services/analyticsService'
import { loadCrmVenues } from '../../features/crm/access/services/accessService'
import type { Catalog, CrmStats, CrmVenue, TenantContext } from '../../types'
import { getReadableError } from '../../utils/errors'
import './crm.css'

export type CrmPageProps = {
  catalog: Catalog | null
  context: TenantContext
  error: string | null
  isOnline: boolean
  onCatalogChanged: () => Promise<void>
  onError: (error: string | null) => void
  onLogout: () => void
}

export function CrmPage({ catalog, context, error, isOnline, onCatalogChanged, onError, onLogout }: CrmPageProps) {
  const [activeSection, setActiveSection] = useState<CrmSection>('dashboard')
  const [isBusy, setIsBusy] = useState(false)
  const [stats, setStats] = useState<CrmStats | null>(null)
  const [venues, setVenues] = useState<CrmVenue[]>([])
  const [selectedVenueId, setSelectedVenueId] = useState('')

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

  const refreshVenues = useCallback(async () => {
    const nextVenues = await loadCrmVenues(context)
    setVenues(nextVenues)
    setSelectedVenueId((current) => resolveSelectedVenueId(nextVenues, current))
  }, [context])

  useEffect(() => {
    if (isOnline) void runAction(refreshVenues)
  }, [isOnline, refreshVenues, runAction])

  const refreshStats = useCallback(async (options: { silent?: boolean } = {}) => {
    const loadStats = async () => {
      onError(null)
      if (!selectedVenueId) {
        setStats(null)
        return
      }
      setStats(await loadCrmStats(context, selectedVenueId))
    }

    if (options.silent) {
      try {
        await loadStats()
      } catch (statsError) {
        onError(getReadableError(statsError))
      }
      return
    }
    await runAction(loadStats)
  }, [context, onError, runAction, selectedVenueId])

  useEffect(() => {
    if ((activeSection === 'dashboard' || activeSection === 'stats') && isOnline && selectedVenueId) void refreshStats()
  }, [activeSection, isOnline, refreshStats, selectedVenueId])

  useEffect(() => {
    if (!isOnline || (activeSection !== 'dashboard' && activeSection !== 'stats')) return undefined

    let refreshTimer: ReturnType<typeof window.setTimeout> | null = null
    const unsubscribe = subscribeToCrmStatsChanges(context, () => {
      if (refreshTimer) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => void refreshStats({ silent: true }), 250)
    })

    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer)
      unsubscribe()
    }
  }, [activeSection, context, isOnline, refreshStats])

  if (!canAccessCrm(context.role)) return null

  const disabled = !isOnline || isBusy
  return (
    <CrmShell
      activeSection={activeSection}
      context={context}
      disabled={disabled}
      error={error}
      isOnline={isOnline}
      onLogout={onLogout}
      onSectionChange={(section) => {
        if (canAccessCrmSection(context.role, section)) setActiveSection(section)
      }}
      onVenueChange={(venueId) => {
        setStats(null)
        setSelectedVenueId(venueId)
      }}
      selectedVenueId={selectedVenueId}
      venues={venues}
    >
      <CrmSectionContent
        activeSection={activeSection}
        catalog={catalog}
        context={context}
        disabled={disabled}
        onCatalogChanged={onCatalogChanged}
        onError={onError}
        onStatsRefresh={refreshStats}
        onVenuesChanged={refreshVenues}
        runAction={runAction}
        selectedVenueId={selectedVenueId}
        stats={stats}
        venues={venues}
      />
    </CrmShell>
  )
}
