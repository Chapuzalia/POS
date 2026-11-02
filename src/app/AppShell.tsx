import { lazy, useCallback, useState } from 'react'
import { AppUpdateBanner } from '../components/feedback/AppUpdateBanner'
import { LoginScreen } from '../components/screens/LoginScreen'
import { LoadingScreen, MissingConfigScreen } from '../components/screens/StateScreens'
import themesData from '../config/themes.json'
import type { AppVersionStatus } from '../config/appVersion'
import { useOfflineController } from '../features/offline/hooks/useOfflineController'
import { useTenantFeatures } from '../features/platform/useTenantFeatures'
import { useLoginActivity, useTenantSession } from '../features/session'
import { useThemeTokens } from '../hooks/useThemeTokens'
import { getCachedContext, saveCachedContext } from '../lib/offlineStore'
import { supabaseConfig } from '../lib/supabase'
import { releaseLocalLoginLock } from '../services/loginLeaseService'
import { logoutTenant } from '../services/posService'
import type { TenantContext, ThemeDefinition } from '../types'
import { AppRouter } from './AppRouter'
import { isCrmUser, isSuperadmin } from './app-permissions'
import { loadApplicationState, loadOfflineApplicationState } from './application-bootstrap'
import type { PosBootstrap } from './application-bootstrap'
import { useDomainErrors } from './useDomainErrors'

const CrmPage = lazy(() => import('../components/crm/CrmPage').then((module) => ({ default: module.CrmPage })))
const SuperAdminPage = lazy(() => import('../components/superadmin/SuperAdminPage').then((module) => ({ default: module.SuperAdminPage })))
const PosRuntime = lazy(() => import('./PosRuntime').then((module) => ({ default: module.PosRuntime })))
const KdsPage = lazy(() => import('../features/production/components/KdsPage').then((module) => ({ default: module.KdsPage })))

const themes = themesData as ThemeDefinition[]
const defaultThemeId = themes[0]?.id ?? 'hero-minimal'

type AppShellProps = {
  networkOnline: boolean
  versionStatus: AppVersionStatus
}

export function AppShell({ networkOnline, versionStatus }: AppShellProps) {
  const { selectedTheme, setThemeId, themeId } = useThemeTokens(themes, defaultThemeId)
  const [sessionReady, setSessionReady] = useState(false)
  const isOnline = networkOnline && sessionReady
  const offline = useOfflineController(networkOnline, sessionReady)
  const [context, setContext] = useState<TenantContext | null>(null)
  const [bootstrap, setBootstrap] = useState<PosBootstrap | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [applicationBusy, setApplicationBusy] = useState(false)
  const [loginLeaseBlocked, setLoginLeaseBlocked] = useState(false)
  const [pendingLoginContext, setPendingLoginContext] = useState<TenantContext | null>(null)
  const { error, errorId, clear: clearErrors, setGeneralError, setSessionError } = useDomainErrors()
  useTenantFeatures(context, isOnline, setContext)

  const clearActiveState = useCallback(() => {
    setContext(null)
    setBootstrap(null)
    setPendingLoginContext(null)
    setApplicationBusy(false)
    clearErrors()
  }, [clearErrors])

  const closeActiveLogin = useCallback(async (message: string, leaseBlocked: boolean) => {
    clearActiveState()
    saveCachedContext(null)
    setLoginLeaseBlocked(leaseBlocked)
    setSessionError(message)
    try { await logoutTenant() }
    catch { releaseLocalLoginLock() }
  }, [clearActiveState, setSessionError])
  useLoginActivity({ context, isOnline, onSessionClosed: closeActiveLogin })

  const applyTenantState = useCallback((nextContext: TenantContext, state: PosBootstrap | null) => {
    state?.persist?.()
    saveCachedContext(nextContext)
    setContext(nextContext)
    setBootstrap(state)
    setLoginLeaseBlocked(false)
  }, [])
  const applyOfflineState = useCallback(async (cachedContext: TenantContext, isCurrent: () => boolean) => {
    const state = await loadOfflineApplicationState(cachedContext)
    if (!isCurrent()) return
    setContext(cachedContext)
    setBootstrap(state)
  }, [])
  const session = useTenantSession({
    context, isOnline: networkOnline, setSessionReady, loginLeaseBlocked, pendingLoginContext,
    loadTenantState: loadApplicationState, applyTenantState, applyOfflineState, clearActiveState,
    syncPendingEvents: offline.syncPendingEvents, setError: setSessionError,
    setIsBootstrapping, setIsBusy, setIsLoading, setLoginLeaseBlocked, setPendingLoginContext,
  })

  const updateBlocked = !networkOnline || isBusy || applicationBusy
    || offline.isSyncing || offline.pendingCount > 0 || Boolean(offline.rejectedSaleEvent)

  if (!selectedTheme) return null
  if (!supabaseConfig.isReady) return <><MissingConfigScreen /><AppUpdateBanner blocked={false} status={versionStatus} /></>
  if (isBootstrapping || (isLoading && !context)) return <><LoadingScreen /><AppUpdateBanner blocked status={versionStatus} /></>
  if (!context) return <><LoginScreen
    allowOfflineEnter={!loginLeaseBlocked && getCachedContext()?.deviceMode !== 'kds'}
    cachedContext={getCachedContext()}
    conflictAccountName={pendingLoginContext?.userName ?? null}
    error={error}
    isBusy={isBusy}
    isOnline={networkOnline}
    onCancelLoginConflict={() => void session.cancelPendingLogin()}
    onForceLoginConflict={() => void session.forceLogin()}
    onLogin={session.login}
    onOfflineEnter={session.enterOffline}
  /><AppUpdateBanner blocked={updateBlocked} status={versionStatus} /></>

  return <><AppRouter context={context}>{() => {
    if (isSuperadmin(context)) return <SuperAdminPage context={context} error={error} isOnline={isOnline} onBusyChange={setApplicationBusy} onError={setGeneralError} onLogout={session.logout} />
    if (isCrmUser(context)) return <CrmPage context={context} error={error} isOnline={isOnline} onBusyChange={setApplicationBusy} onError={setGeneralError} onLogout={session.logout} />
    if (context.deviceMode === 'kds') return <KdsPage context={context} isOnline={isOnline} onBusyChange={setApplicationBusy} onLogout={session.logout} />
    if (!bootstrap) return <LoadingScreen />
    return <PosRuntime
      key={`${context.tenantId}:${context.venueId}:${context.deviceId}:${context.userId}`}
      context={context} bootstrap={bootstrap} offline={offline} isOnline={isOnline}
      error={error} errorId={errorId} onError={setGeneralError} onLogout={session.logout}
      onBusyChange={setApplicationBusy} themes={themes} selectedThemeId={themeId} setThemeId={setThemeId}
    />
  }}</AppRouter><AppUpdateBanner blocked={updateBlocked} status={versionStatus} /></>
}

export default AppShell
