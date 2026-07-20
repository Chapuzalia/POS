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
import { isAdministrativeUser } from '../../../app/app-permissions'

type UseTenantSessionOptions<TenantState> = {
  isOnline: boolean
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
  latestOptionsRef.current = options
  const {
    applyOfflineState, applyTenantState, clearActiveState, isOnline, loadTenantState,
    loginLeaseBlocked, pendingLoginContext, setError, setIsBusy,
    setIsLoading, setLoginLeaseBlocked, setPendingLoginContext, syncPendingEvents,
  } = options

  const activateAuthenticatedContext = useCallback(async (context: TenantContext) => {
    if (!isAdministrativeUser(context)) await syncPendingEvents()
    applyTenantState(context, await loadTenantState(context))
  }, [applyTenantState, loadTenantState, syncPendingEvents])

  useEffect(() => {
    if (!supabase) return undefined
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        latestOptionsRef.current.clearActiveState()
        saveCachedContext(null)
      }
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let cancelled = false
    const restoreOnlineState = async () => {
      const current = latestOptionsRef.current
      if (!supabaseConfig.isReady || !isOnline) {
        current.setIsBootstrapping(false)
        return
      }
      const cachedContext = getCachedContext()
      if (!cachedContext) {
        current.setIsBootstrapping(false)
        return
      }
      current.setIsBusy(true)
      current.setIsLoading(true)
      current.setError(null)
      try {
        const context = await restoreTenantContext(cachedContext)
        if (!isAdministrativeUser(context)) await current.syncPendingEvents()
        const state = await current.loadTenantState(context)
        if (!cancelled) current.applyTenantState(context, state)
      } catch (error) {
        if (!cancelled) {
          const leaseConflict = error instanceof LoginLeaseConflictError
          current.clearActiveState()
          current.setLoginLeaseBlocked(leaseConflict)
          if (leaseConflict) {
            current.setPendingLoginContext(error.context)
            current.setError(null)
          } else if (error instanceof TenantSessionError) {
            saveCachedContext(null)
            current.setError(getReadableError(error))
          } else {
            current.setError(getReadableError(error))
          }
        }
      } finally {
        if (!cancelled) {
          current.setIsBootstrapping(false)
          current.setIsBusy(false)
          current.setIsLoading(false)
        }
      }
    }
    void restoreOnlineState()
    return () => { cancelled = true }
  }, [isOnline])

  const login = useCallback(async (input: LoginInput) => {
    setIsBusy(true); setIsLoading(true); setError(null)
    setLoginLeaseBlocked(false); setPendingLoginContext(null)
    try {
      await activateAuthenticatedContext(await loginTenant(input))
    } catch (error) {
      if (error instanceof LoginLeaseConflictError) {
        setLoginLeaseBlocked(true); setPendingLoginContext(error.context); setError(null)
      } else setError(getReadableError(error))
    } finally { setIsBusy(false); setIsLoading(false) }
  }, [activateAuthenticatedContext, setError, setIsBusy, setIsLoading, setLoginLeaseBlocked, setPendingLoginContext])

  const forceLogin = useCallback(async () => {
    if (!pendingLoginContext) return
    setIsBusy(true); setError(null)
    try {
      if (!(await forceClaimLoginLease())) throw new Error('No se ha podido sustituir la sesion anterior.')
      await activateAuthenticatedContext(pendingLoginContext)
      setPendingLoginContext(null); setLoginLeaseBlocked(false)
    } catch (error) { setError(getReadableError(error)) } finally { setIsBusy(false) }
  }, [activateAuthenticatedContext, pendingLoginContext, setError, setIsBusy, setLoginLeaseBlocked, setPendingLoginContext])

  const cancelPendingLogin = useCallback(async () => {
    setIsBusy(true); setError(null)
    try { await logoutTenant() } catch (error) { releaseLocalLoginLock(); setError(getReadableError(error)) }
    finally { setPendingLoginContext(null); setLoginLeaseBlocked(false); saveCachedContext(null); setIsBusy(false) }
  }, [setError, setIsBusy, setLoginLeaseBlocked, setPendingLoginContext])

  const enterOffline = useCallback(async () => {
    if (loginLeaseBlocked) return
    const context = getCachedContext()
    if (!context) return
    setIsBusy(true); setError(null)
    try {
      if (isAdministrativeUser(context)) throw new TenantSessionError('El CRM de administracion requiere conexion.')
      if (!(await hasValidOfflineSession(context))) throw new TenantSessionError('La sesion ha caducado. Conecta el TPV e inicia sesion de nuevo.')
      await applyOfflineState(context)
    } catch (error) { setError(getReadableError(error)) } finally { setIsBusy(false) }
  }, [applyOfflineState, loginLeaseBlocked, setError, setIsBusy])

  const logout = useCallback(async () => {
    setIsBusy(true); setError(null)
    try { await logoutTenant() } catch (error) { setError(getReadableError(error)) }
    finally { clearActiveState(); saveCachedContext(null); setIsBusy(false) }
  }, [clearActiveState, setError, setIsBusy])

  return { login, forceLogin, cancelPendingLogin, enterOffline, logout }
}
