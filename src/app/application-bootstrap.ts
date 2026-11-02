import type { TenantContext } from '../types'
import type { loadTenantState } from '../features/session/services/loadTenantState'
import { isBackofficeUser } from './app-permissions'

export type PosBootstrap = {
  source: 'online' | 'offline'
  state: Awaited<ReturnType<typeof loadTenantState>>
  persist?: () => void
}

export async function loadApplicationState(context: TenantContext): Promise<PosBootstrap | null> {
  if (isBackofficeUser(context) || context.deviceMode === 'kds') return null
  const { loadTenantState, saveTenantState } = await import('../features/session/services/loadTenantState')
  const state = await loadTenantState(context)
  return { source: 'online', state, persist: () => saveTenantState(context, state) }
}

export async function loadOfflineApplicationState(context: TenantContext): Promise<PosBootstrap> {
  const { loadCachedTenantState } = await import('../features/session/services/loadTenantState')
  return { source: 'offline', state: loadCachedTenantState(context) }
}
