import type { TenantAddonKey } from './tenantFeatureAccess'

export const TENANT_FEATURE_REFRESH_MS = 60_000

export function createTenantFeatureRefresh(
  load: () => Promise<TenantAddonKey[] | undefined>,
  initiallyLoaded: boolean,
  now: () => number = Date.now,
) {
  let lastAttempt = initiallyLoaded ? now() : Number.NEGATIVE_INFINITY
  let inFlight: Promise<TenantAddonKey[] | undefined> | null = null

  return {
    refreshIfStale() {
      if (inFlight) return inFlight
      if (now() - lastAttempt < TENANT_FEATURE_REFRESH_MS) return Promise.resolve(undefined)
      lastAttempt = now()
      inFlight = Promise.resolve().then(load).finally(() => { inFlight = null })
      return inFlight
    },
  }
}

export function subscribeTenantFeatureRefresh(
  refresh: () => Promise<void>,
  browserWindow: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setInterval' | 'clearInterval'> = window,
  browserDocument: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> = document,
) {
  let intervalId: number | undefined
  const refreshWhenVisible = () => {
    if (browserDocument.visibilityState === 'visible') void refresh()
  }
  const handleVisibility = () => {
    if (intervalId !== undefined) browserWindow.clearInterval(intervalId)
    intervalId = undefined
    if (browserDocument.visibilityState !== 'visible') return
    refreshWhenVisible()
    intervalId = browserWindow.setInterval(refreshWhenVisible, TENANT_FEATURE_REFRESH_MS)
  }

  handleVisibility()
  browserWindow.addEventListener('focus', refreshWhenVisible)
  browserDocument.addEventListener('visibilitychange', handleVisibility)
  return () => {
    if (intervalId !== undefined) browserWindow.clearInterval(intervalId)
    browserWindow.removeEventListener('focus', refreshWhenVisible)
    browserDocument.removeEventListener('visibilitychange', handleVisibility)
  }
}
