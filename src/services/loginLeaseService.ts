import { supabase } from '../lib/supabase'

const deviceIdKey = 'club-pos:login-device-id'
const instanceIdKey = 'club-pos:login-instance-id'
const legacyClientIdKey = 'club-pos:login-client-id'

type LoginIdentity = {
  deviceId: string
  instanceId: string
}

let activeIdentity: LoginIdentity | null = null
let fallbackDeviceId: string | null = null

function createId() {
  return crypto.randomUUID()
}

function getDeviceId() {
  if (fallbackDeviceId) return fallbackDeviceId

  try {
    const storedDeviceId = localStorage.getItem(deviceIdKey)
    if (storedDeviceId) {
      fallbackDeviceId = storedDeviceId
      return storedDeviceId
    }

    // Preserve ownership across this rollout when the old session-scoped id exists.
    const legacyClientId = sessionStorage.getItem(legacyClientIdKey)
    const deviceId = legacyClientId ?? createId()
    localStorage.setItem(deviceIdKey, deviceId)
    fallbackDeviceId = deviceId
    return deviceId
  } catch {
    fallbackDeviceId = createId()
    return fallbackDeviceId
  }
}

function getInstanceId() {
  const instanceId = sessionStorage.getItem(instanceIdKey) ?? createId()
  sessionStorage.setItem(instanceIdKey, instanceId)
  return instanceId
}

function getLoginIdentity() {
  if (activeIdentity) {
    return activeIdentity
  }

  activeIdentity = {
    deviceId: getDeviceId(),
    instanceId: getInstanceId(),
  }
  sessionStorage.removeItem(legacyClientIdKey)
  return activeIdentity
}

export async function claimLoginLease(allowSameDevice = true) {
  if (!supabase) {
    throw new Error('Supabase no está configurado.')
  }

  const identity = getLoginIdentity()
  const { data, error } = await supabase.rpc('claim_user_login', {
    p_allow_same_device: allowSameDevice,
    p_client_id: identity.instanceId,
    p_device_id: identity.deviceId,
  })

  if (error) {
    throw error
  }

  return data === true
}

export async function forceClaimLoginLease() {
  if (!supabase) {
    throw new Error('Supabase no está configurado.')
  }

  const identity = getLoginIdentity()
  const { data, error } = await supabase.rpc('force_claim_user_login', {
    p_client_id: identity.instanceId,
    p_device_id: identity.deviceId,
  })

  if (error) {
    throw error
  }

  return data === true
}

export async function heartbeatLoginLease() {
  if (!supabase || !activeIdentity) {
    return false
  }

  const { data, error } = await supabase.rpc('heartbeat_user_login', {
    p_client_id: activeIdentity.instanceId,
    p_device_id: activeIdentity.deviceId,
  })

  if (error) {
    throw error
  }

  return data === true
}

export async function checkLoginLease() {
  if (!supabase || !activeIdentity) {
    return false
  }

  const { data, error } = await supabase.rpc('check_user_login', {
    p_client_id: activeIdentity.instanceId,
    p_device_id: activeIdentity.deviceId,
  })

  if (error) {
    throw error
  }

  return data === true
}

export async function releaseLoginLease() {
  if (supabase && activeIdentity) {
    const { error } = await supabase.rpc('release_user_login', {
      p_client_id: activeIdentity.instanceId,
      p_device_id: activeIdentity.deviceId,
    })

    if (error) {
      throw error
    }
  }

  releaseLocalLoginLock()
}

export function releaseLocalLoginLock() {
  activeIdentity = null
  sessionStorage.removeItem(instanceIdKey)
  sessionStorage.removeItem(legacyClientIdKey)
}
