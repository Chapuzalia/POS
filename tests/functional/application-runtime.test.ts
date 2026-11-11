import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { loadApplicationState, loadOfflineApplicationState } from '../../src/app/application-bootstrap'
import type { TenantContext } from '../../src/types'
import * as tenantFeatureAccess from '../../src/features/platform/tenantFeatureAccess'
import { createCompiledHookRunner, jsxRuntime } from '../helpers/component-harness.mjs'

const loaders = vi.hoisted(() => ({ online: vi.fn(), offline: vi.fn(), persist: vi.fn() }))
vi.mock('../../src/features/session/services/loadTenantState', () => ({
  loadTenantState: loaders.online,
  loadCachedTenantState: loaders.offline,
  saveTenantState: loaders.persist,
}))

const context = { role: 'cashier', deviceMode: 'checkout', tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user' } as TenantContext
beforeEach(() => { loaders.online.mockReset(); loaders.offline.mockReset(); loaders.persist.mockReset() })

it.each([
  { ...context, role: 'owner' },
  { ...context, role: 'manager' },
  { ...context, role: 'superadmin' },
  { ...context, deviceMode: 'kds' },
] as TenantContext[])('does not initialize POS data for $role/$deviceMode', async (scope) => {
  expect(await loadApplicationState(scope)).toBeNull()
  expect(loaders.online).not.toHaveBeenCalled()
  expect(loaders.offline).not.toHaveBeenCalled()
})

it('preserves the online POS snapshot and original scope for hydration', async () => {
  const state = { cashSession: { id: 'cash' }, salesLedger: [{ id: 'sale' }] }
  loaders.online.mockResolvedValue(state)
  const bootstrap = await loadApplicationState(context)
  expect(bootstrap).toMatchObject({ source: 'online', state })
  expect(loaders.persist).not.toHaveBeenCalled()
  bootstrap?.persist?.()
  expect(loaders.persist).toHaveBeenCalledWith(context, state)
  expect(loaders.online).toHaveBeenCalledWith(context)
})

it('restores cached POS state without running online loaders', async () => {
  const state = { catalog: null, cashSession: { id: 'cash' }, salesLedger: [{ id: 'pending' }] }
  loaders.offline.mockReturnValue(state)
  expect(await loadOfflineApplicationState(context)).toEqual({ source: 'offline', state })
  expect(loaders.online).not.toHaveBeenCalled()
})

it('leaves failed POS preparation recoverable instead of activating an empty session', async () => {
  loaders.online.mockRejectedValue(new Error('backend unavailable'))
  await expect(loadApplicationState(context)).rejects.toThrow('backend unavailable')
})

it('keeps operation controllers out of the shared application shell', () => {
  const source = readFileSync(new URL('../../src/app/AppShell.tsx', import.meta.url), 'utf8')
  // A static import here makes every CRM/KDS login initialize POS code again.
  expect(source).not.toMatch(/import\s+(?!type\b)[^\n]*from ['"][^'"]*(?:cash-registers|quick-sale|restaurant|reservations|local-printing)/)
  expect(source).toContain("import('./PosRuntime')")
})

function shellHarness(loadOffline: () => Promise<unknown>) {
  let options: {
    applyOfflineState: (context: TenantContext, isCurrent: () => boolean) => Promise<void>
    applyTenantState: (context: TenantContext, state: unknown) => void
    setIsBootstrapping: (busy: boolean) => void
  }
  const harness = createCompiledHookRunner(readFileSync(new URL('../../src/app/AppShell.tsx', import.meta.url), 'utf8'), 'AppShell', {
    'react/jsx-runtime': jsxRuntime,
    '../components/feedback/AppUpdateBanner': { AppUpdateBanner: 'Update' },
    '../components/screens/LoginScreen': { LoginScreen: 'Login' },
    '../components/screens/StateScreens': { LoadingScreen: 'Loading', MissingConfigScreen: 'Missing' },
    '../config/themes.json': { default: [{ id: 'theme' }] },
    '../features/offline/hooks/useOfflineController': { useOfflineController: () => ({ pendingCount: 0 }) },
    '../features/platform/useTenantFeatures': { useTenantFeatures() {} },
    '../features/platform/tenantFeatureAccess': tenantFeatureAccess,
    '../features/session': { useLoginActivity() {}, useTenantSession: (value: typeof options) => { options = value; value.setIsBootstrapping(false); return {} } },
    '../hooks/useThemeTokens': { useThemeTokens: () => ({ selectedTheme: {}, themeId: 'theme', setThemeId() {} }) },
    '../lib/offlineStore': { getCachedContext: () => null, saveCachedContext() {} },
    '../lib/supabase': { supabaseConfig: { isReady: true } },
    '../services/loginLeaseService': { releaseLocalLoginLock() {} },
    '../services/posService': { logoutTenant: async () => {} },
    './AppRouter': { AppRouter: 'Router' },
    './app-permissions': { isCrmUser: (c: TenantContext) => c.role === 'owner', isSuperadmin: () => false },
    './application-bootstrap': { loadApplicationState, loadOfflineApplicationState: loadOffline },
    './useDomainErrors': { useDomainErrors: () => ({ clear() {}, setGeneralError() {}, setSessionError() {}, error: null, errorId: 0 }) },
  })
  const render = () => harness.render({ networkOnline: true, versionStatus: 'compatible' })
  render()
  return { render, options: () => options!, unmount: () => harness.unmount() }
}

it('does not reactivate a signed-out session when a deferred offline bootstrap finishes', async () => {
  let resolve!: (value: unknown) => void
  const shell = shellHarness(() => new Promise(done => { resolve = done }))
  let active = true
  const restore = shell.options().applyOfflineState(context, () => active)
  active = false
  resolve({ source: 'offline', state: {} })
  await restore
  expect(shell.render().props.children[0].type).toBe('Login')
  shell.unmount()
})

it('does not activate a POS session if persisting its prepared cache fails', () => {
  const shell = shellHarness(async () => null)
  expect(() => shell.options().applyTenantState(context, {
    source: 'online', state: {}, persist: () => { throw new Error('Storage full') },
  })).toThrow('Storage full')
  expect(shell.render().props.children[0].type).toBe('Login')
  shell.unmount()
})
