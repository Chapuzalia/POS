import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getAppRoute, type AppRoute } from '../app/app-routes'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? ''
const initialAppRoute = getAppRoute()

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
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        storageKey: authStorageKey(initialAppRoute),
      },
    })
  : null

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
