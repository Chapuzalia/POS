import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getAppRoute, type AppRoute } from '../app/app-routes'
import { hasPersistedSessionForUser } from '../features/session/services/sessionValidity'
import { backendFetch } from './backendFetch'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? ''
const initialAppRoute = getAppRoute()
const realtimeHeartbeatStaleMs = 60_000
let lastRealtimeHeartbeatStatus: string | null = null
let lastRealtimeHeartbeatOkAt = Date.now()
let realtimeRecoveryPromise: Promise<void> | null = null

function monitorRealtimeHeartbeat(status: string, latency?: number) {
  lastRealtimeHeartbeatStatus = status
  if (status === 'ok') lastRealtimeHeartbeatOkAt = Date.now()
  if (status === 'error' || status === 'timeout' || status === 'disconnected') {
    console.warn('Supabase Realtime heartbeat no disponible.', { latency, status })
  }
}

function authStorageKey(route: AppRoute) {
  return `club-pos:supabase-auth:${route}`
}

function migrateLegacyAuthStorage() {
  if (!supabaseUrl || typeof window === 'undefined') return
  try {
    const targetKey = authStorageKey(initialAppRoute)
    const legacyKey = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
    const legacySession = window.localStorage.getItem(legacyKey)
    if (!window.localStorage.getItem(targetKey) && legacySession) {
      window.localStorage.setItem(targetKey, legacySession)
      window.localStorage.removeItem(legacyKey)
    }
  } catch {
    // A fresh login still works when browser storage is unavailable.
  }
}

migrateLegacyAuthStorage()

export const supabaseConfig = {
  url: supabaseUrl,
  anonKey: supabaseAnonKey,
  isReady: Boolean(supabaseUrl && supabaseAnonKey),
}

export const supabase: SupabaseClient | null = supabaseConfig.isReady
  ? createClient(supabaseUrl, supabaseAnonKey, {
      global: { fetch: backendFetch },
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        storageKey: authStorageKey(initialAppRoute),
      },
      realtime: {
        heartbeatCallback: monitorRealtimeHeartbeat,
        worker: true,
      },
    })
  : null

export function recoverSupabaseRealtimeConnection() {
  const realtime = supabase?.realtime
  if (!realtime || realtimeRecoveryPromise) return realtimeRecoveryPromise ?? Promise.resolve()

  const connectionState = realtime.connectionState()
  if (connectionState === 'closed') {
    realtime.connect()
    return Promise.resolve()
  }

  const heartbeatIsUnhealthy = lastRealtimeHeartbeatStatus === 'error'
    || lastRealtimeHeartbeatStatus === 'timeout'
    || lastRealtimeHeartbeatStatus === 'disconnected'
    || Date.now() - lastRealtimeHeartbeatOkAt > realtimeHeartbeatStaleMs

  if (connectionState !== 'open' || !heartbeatIsUnhealthy) return Promise.resolve()

  realtimeRecoveryPromise = realtime.disconnect()
    .then(() => realtime.connect())
    .finally(() => { realtimeRecoveryPromise = null })
  return realtimeRecoveryPromise
}

export function hasLocalSupabaseSession(userId: string) {
  try {
    return hasPersistedSessionForUser(window.localStorage.getItem(authStorageKey(initialAppRoute)), userId)
  } catch {
    return false
  }
}

export function moveSupabaseSessionToRoute(route: AppRoute) {
  if (route === initialAppRoute || typeof window === 'undefined') return
  try {
    const sourceKey = authStorageKey(initialAppRoute)
    const targetKey = authStorageKey(route)
    const session = window.localStorage.getItem(sourceKey)
    if (session) window.localStorage.setItem(targetKey, session)
    window.localStorage.removeItem(sourceKey)
  } catch {
    // The destination route will show login if storage cannot be migrated.
  }
}
