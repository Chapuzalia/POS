import { supabase } from '../lib/supabase'

const clientIdKey = 'club-pos:login-client-id'
let activeClientId: string | null = null
let releaseBrowserLock: (() => void) | null = null

function createClientId() {
  return crypto.randomUUID()
}

async function holdBrowserLock(clientId: string) {
  if (!navigator.locks) {
    return true
  }

  let resolveAcquired: (acquired: boolean) => void = () => undefined
  const acquired = new Promise<boolean>((resolve) => {
    resolveAcquired = resolve
  })

  void navigator.locks.request(`club-pos-login:${clientId}`, { ifAvailable: true }, (lock) => {
    resolveAcquired(Boolean(lock))

    if (!lock) {
      return undefined
    }

    return new Promise<void>((resolve) => {
      releaseBrowserLock = resolve
    })
  })

  return acquired
}

async function getClientId() {
  if (activeClientId) {
    return activeClientId
  }

  let candidate = sessionStorage.getItem(clientIdKey) ?? createClientId()

  if (!(await holdBrowserLock(candidate))) {
    candidate = createClientId()
    await holdBrowserLock(candidate)
  }

  sessionStorage.setItem(clientIdKey, candidate)
  activeClientId = candidate
  return candidate
}

export async function claimLoginLease() {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  const clientId = await getClientId()
  const { data, error } = await supabase.rpc('claim_user_login', { p_client_id: clientId })

  if (error) {
    throw error
  }

  return data === true
}

export async function heartbeatLoginLease() {
  if (!supabase || !activeClientId) {
    return false
  }

  const { data, error } = await supabase.rpc('heartbeat_user_login', { p_client_id: activeClientId })

  if (error) {
    throw error
  }

  return data === true
}

export async function checkLoginLease() {
  if (!supabase || !activeClientId) {
    return false
  }

  const { data, error } = await supabase.rpc('check_user_login', { p_client_id: activeClientId })

  if (error) {
    throw error
  }

  return data === true
}

export async function releaseLoginLease() {
  if (supabase && activeClientId) {
    const { error } = await supabase.rpc('release_user_login', { p_client_id: activeClientId })

    if (error) {
      throw error
    }
  }

  releaseLocalLoginLock()
}

export function releaseLocalLoginLock() {
  releaseBrowserLock?.()
  releaseBrowserLock = null
  activeClientId = null
  sessionStorage.removeItem(clientIdKey)
}
