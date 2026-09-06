import { useCallback, useEffect, useRef } from 'react'
import { getCachedContext, saveCachedContext } from '../../../lib/offlineStore'
import { supabase, supabaseConfig } from '../../../lib/supabase'
import {
  LoginLeaseConflictError,
  TenantSessionError,
  hasValidOfflineSession,
  loginTenant,
  logoutTenant,
  restoreTenantContext,
} from '../../../services/posService'
import { forceClaimLoginLease, releaseLocalLoginLock } from '../../../services/loginLeaseService'
import type { LoginInput, TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { isBackofficeUser } from '../../../app/app-permissions'
import { addDiagnosticBreadcrumb } from '../../../lib/diagnostics'
import { backendUnavailableEvent } from '../../../lib/backendFetch'

type UseTenantSessionOptions<TenantState> = {
  context: TenantContext | null
  isOnline: boolean
  setSessionReady: (value: boolean) => void
  loginLeaseBlocked: boolean
  pendingLoginContext: TenantContext | null
  loadTenantState: (context: TenantContext) => Promise<TenantState>
  applyTenantState: (context: TenantContext, state: TenantState) => void
  applyOfflineState: (context: TenantContext) => Promise<void>
  clearActiveState: () => void
  syncPendingEvents: () => Promise<void>
  setError: (error: string | null) => void
  setIsBootstrapping: (value: boolean) => void
  setIsBusy: (value: boolean) => void
  setIsLoading: (value: boolean) => void
  setLoginLeaseBlocked: (value: boolean) => void
  setPendingLoginContext: (context: TenantContext | null) => void
}

export function useTenantSession<TenantState>(options: UseTenantSessionOptions<TenantState>) {
  const latestOptionsRef = useRef(options)
  const hasRestoredOnceRef = useRef(false)
  const sessionVersionRef = useRef(0)
  const pendingValidationRef = useRef(true)
  latestOptionsRef.current = options
  const {
    applyOfflineState, applyTenantState, clearActiveState, isOnline, loadTenantState,
    loginLeaseBlocked, pendingLoginContext, setError, setIsBusy,
    setIsLoading, setLoginLeaseBlocked, setPendingLoginContext, syncPendingEvents,
  } = options

  const activateAuthenticatedContext = useCallback(async (context: TenantContext) => {
    if (!isBackofficeUser(context)) await syncPendingEvents()
    applyTenantState(context, await loadTenantState(context))
    pendingValidationRef.current = false
    latestOptionsRef.current.setSessionReady(true)
  }, [applyTenantState, loadTenantState, syncPendingEvents])

  useEffect(() => {
    if (!supabase) return undefined
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        // Supabase preserves sessions on retryable refresh errors. This event
        // is authoritative (including manual logout and logout in another tab).
        sessionVersionRef.current += 1
        pendingValidationRef.current = false
        latestOptionsRef.current.setSessionReady(false)
        latestOptionsRef.current.clearActiveState()
        saveCachedContext(null)
        releaseLocalLoginLock()
      }
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let retryTimer: ReturnType<typeof window.setTimeout> | undefined
    const restoreOnlineState = async () => {
      if (cancelled || inFlight) return
      window.clearTimeout(retryTimer)
      retryTimer = undefined
      const current = latestOptionsRef.current
      const version = sessionVersionRef.current
      const isCurrent = () => !cancelled && version === sessionVersionRef.current
      const cachedContext = getCachedContext()
      if (!supabaseConfig.isReady || !cachedContext || current.loginLeaseBlocked) {
        current.setIsBootstrapping(false)
        return
      }
      inFlight = true
      pendingValidationRef.current = true
      current.setSessionReady(false)
      if (!current.context) {
        current.setIsBusy(true)
        current.setIsLoading(true)
      }
      current.setError(null)
      const source = hasRestoredOnceRef.current ? 'reconnect' : 'initial'
      addDiagnosticBreadcrumb('session.restore_started', { source, venueId: cachedContext.venueId })
      let succeeded = false
      try {
        if (!isOnline) {
          if (!current.context && !isBackofficeUser(cachedContext) && cachedContext.deviceMode !== 'kds'
            && await hasValidOfflineSession(cachedContext) && isCurrent()) {
            await current.applyOfflineState(cachedContext)
          }
          return
        }
        const context = await restoreTenantContext(cachedContext)
        if (!isCurrent()) return
        if (!isBackofficeUser(context)) await current.syncPendingEvents()
        if (!isCurrent()) return
        const state = await current.loadTenantState(context)
        if (isCurrent()) {
          latestOptionsRef.current.applyTenantState(context, state)
          pendingValidationRef.current = false
          current.setSessionReady(true)
          hasRestoredOnceRef.current = true
          succeeded = true
        }
      } catch (error) {
        if (isCurrent()) {
          const leaseConflict = error instanceof LoginLeaseConflictError
          if (leaseConflict) {
            pendingValidationRef.current = false
            current.clearActiveState()
            current.setLoginLeaseBlocked(true)
            current.setPendingLoginContext(error.context)
            current.setError(null)
          } else if (error instanceof TenantSessionError) {
            pendingValidationRef.current = false
            sessionVersionRef.current += 1
            current.clearActiveState()
            saveCachedContext(null)
            current.setError(getReadableError(error, { operation: 'auth.session', recoverable: true }))
            void logoutTenant().catch(() => releaseLocalLoginLock())
          } else {
            // A failed auth/catalog/cash/lease request is not a logout. Keep
            // live state intact; hydrate storage only when booting the app.
            if (!latestOptionsRef.current.context && !isBackofficeUser(cachedContext)
              && cachedContext.deviceMode !== 'kds' && await hasValidOfflineSession(cachedContext) && isCurrent()) {
              await latestOptionsRef.current.applyOfflineState(cachedContext)
            }
            current.setError(getReadableError(error, { operation: 'auth.session', recoverable: true }))
          }
        }
      } finally {
        inFlight = false
        addDiagnosticBreadcrumb('session.restore_finished', {
          source,
          succeeded,
          venueId: cachedContext.venueId,
        })
        if (!cancelled) {
          current.setIsBootstrapping(false)
          current.setIsBusy(false)
          current.setIsLoading(false)
          if (isCurrent() && isOnline && pendingValidationRef.current) {
            // Retry only while degraded, never a heartbeat for an idle app.
            window.clearTimeout(retryTimer)
            retryTimer = window.setTimeout(() => {
              retryTimer = undefined
              if (pendingValidationRef.current) void restoreOnlineState()
            }, 15_000)
          }
        }
      }
    }
    const retryWhenVisible = () => {
      if (pendingValidationRef.current && document.visibilityState === 'visible') void restoreOnlineState()
    }
    const retryOnline = () => {
      if (pendingValidationRef.current) void restoreOnlineState()
    }
    const markDegraded = () => {
      if (!getCachedContext() || latestOptionsRef.current.loginLeaseBlocked) return
      pendingValidationRef.current = true
      latestOptionsRef.current.setSessionReady(false)
      if (isOnline && !inFlight && !retryTimer) {
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined
          void restoreOnlineState()
        }, 15_000)
      }
    }
    void restoreOnlineState()
    window.addEventListener(backendUnavailableEvent, markDegraded)
    window.addEventListener('online', retryOnline)
    window.addEventListener('focus', retryWhenVisible)
    document.addEventListener('visibilitychange', retryWhenVisible)
    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
      window.removeEventListener(backendUnavailableEvent, markDegraded)
      window.removeEventListener('online', retryOnline)
      window.removeEventListener('focus', retryWhenVisible)
      document.removeEventListener('visibilitychange', retryWhenVisible)
    }
  }, [isOnline])

  const login = useCallback(async (input: LoginInput) => {
    setIsBusy(true); setIsLoading(true); setError(null)
    setLoginLeaseBlocked(false); setPendingLoginContext(null)
    try {
      await activateAuthenticatedContext(await loginTenant(input))
    } catch (error) {
      if (error instanceof LoginLeaseConflictError) {
        setLoginLeaseBlocked(true); setPendingLoginContext(error.context); setError(null)
      } else setError(getReadableError(error, { operation: 'auth.session', recoverable: true, step: 'login' }))
    } finally { setIsBusy(false); setIsLoading(false) }
  }, [activateAuthenticatedContext, setError, setIsBusy, setIsLoading, setLoginLeaseBlocked, setPendingLoginContext])

  const forceLogin = useCallback(async () => {
    if (!pendingLoginContext) return
    setIsBusy(true); setError(null)
    try {
      if (!(await forceClaimLoginLease())) throw new Error('No se ha podido sustituir la sesión anterior.')
      await activateAuthenticatedContext(pendingLoginContext)
      setPendingLoginContext(null); setLoginLeaseBlocked(false)
    } catch (error) { setError(getReadableError(error, { operation: 'auth.session', recoverable: true, step: 'forceLogin' })) } finally { setIsBusy(false) }
  }, [activateAuthenticatedContext, pendingLoginContext, setError, setIsBusy, setLoginLeaseBlocked, setPendingLoginContext])

  const cancelPendingLogin = useCallback(async () => {
    sessionVersionRef.current += 1
    pendingValidationRef.current = false
    latestOptionsRef.current.setSessionReady(false)
    saveCachedContext(null)
    setIsBusy(true); setError(null)
    try { await logoutTenant() } catch (error) { releaseLocalLoginLock(); setError(getReadableError(error, { operation: 'auth.session', recoverable: true, step: 'cancelPendingLogin' })) }
    finally { setPendingLoginContext(null); setLoginLeaseBlocked(false); saveCachedContext(null); setIsBusy(false) }
  }, [setError, setIsBusy, setLoginLeaseBlocked, setPendingLoginContext])

  const enterOffline = useCallback(async () => {
    if (loginLeaseBlocked) return
    const context = getCachedContext()
    if (!context) return
    setIsBusy(true); setError(null)
    try {
      if (isBackofficeUser(context)) throw new TenantSessionError('El CRM requiere conexión.')
      if (!(await hasValidOfflineSession(context))) throw new TenantSessionError('La sesión ha caducado. Conecta el TPV e inicia sesión de nuevo.')
      await applyOfflineState(context)
    } catch (error) { setError(getReadableError(error, { operation: 'auth.session', recoverable: true, step: 'enterOffline' })) } finally { setIsBusy(false) }
  }, [applyOfflineState, loginLeaseBlocked, setError, setIsBusy])

  const logout = useCallback(async () => {
    sessionVersionRef.current += 1
    pendingValidationRef.current = false
    latestOptionsRef.current.setSessionReady(false)
    saveCachedContext(null)
    setIsBusy(true); setError(null)
    try { await logoutTenant() } catch (error) { setError(getReadableError(error, { operation: 'auth.session', recoverable: true, step: 'logout' })) }
    finally { clearActiveState(); saveCachedContext(null); setIsBusy(false) }
  }, [clearActiveState, setError, setIsBusy])

  return { login, forceLogin, cancelPendingLogin, enterOffline, logout }
}
