import { supabase } from '../lib/supabase'
import { getFunctionInvokeErrorMessage } from '../features/crm/shared/services/crmServiceSupport'

export type PlatformTenant = {
  id: string
  name: string
  slug: string
  createdAt: string
  deviceCount: number
  isActive: boolean
  memberCount: number
  venueCount: number
  venues: Array<{
    id: string
    isActive: boolean
    name: string
  }>
  owner: {
    email: string
    fullName: string
    isActive: boolean
  } | null
  limits: {
    devices: number
    venues: number
  }
}

export type CreatePlatformTenantInput = {
  tenantName: string
  tenantSlug: string
  venueName: string
  ownerEmail: string
  ownerPassword: string
  ownerFullName: string
  maxDevices: number
  maxVenues: number
}

export type UpdatePlatformTenantInput = {
  tenantId: string
  tenantName: string
  tenantSlug: string
  maxDevices: number
  maxVenues: number
}

function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }
  return supabase
}

function getFunctionError(data: unknown) {
  if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
    return data.error
  }
  return null
}

export async function loadPlatformTenants(): Promise<PlatformTenant[]> {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ tenants?: PlatformTenant[]; error?: string }>(
    'manage-pos-users',
    { body: { action: 'platform-list' } },
  )
  const functionError = getFunctionError(data)
  if (error || functionError) {
    throw new Error(await getFunctionInvokeErrorMessage(data, error, 'No se pudieron cargar los negocios.'))
  }
  return data?.tenants ?? []
}

export async function createPlatformTenant(input: CreatePlatformTenantInput) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{
    tenant?: Pick<PlatformTenant, 'id' | 'name' | 'slug' | 'createdAt'>
    ownerId?: string
    error?: string
  }>(
    'manage-pos-users',
    { body: { action: 'platform-create-tenant', ...input } },
  )
  const functionError = getFunctionError(data)
  if (error || functionError) {
    throw new Error(await getFunctionInvokeErrorMessage(data, error, 'No se pudo crear el negocio.'))
  }
  if (!data?.tenant) {
    throw new Error('La funcion no devolvio el negocio creado.')
  }
  return data.tenant
}

async function invokePlatformAction<T>(body: Record<string, unknown>, fallbackError: string) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<T & { error?: string }>(
    'manage-pos-users',
    { body },
  )
  const functionError = getFunctionError(data)
  if (error || functionError) {
    throw new Error(await getFunctionInvokeErrorMessage(data, error, fallbackError))
  }
  return data
}

export async function updatePlatformTenant(input: UpdatePlatformTenantInput) {
  return invokePlatformAction<{ tenant?: Pick<PlatformTenant, 'id' | 'name' | 'slug'> }>(
    { action: 'platform-update-tenant', ...input },
    'No se pudo actualizar el negocio.',
  )
}

export async function setPlatformTenantActive(tenantId: string, isActive: boolean) {
  return invokePlatformAction<{ ok?: boolean }>(
    { action: 'platform-set-tenant-active', isActive, tenantId },
    `No se pudo ${isActive ? 'activar' : 'desactivar'} el negocio.`,
  )
}

export async function deletePlatformTenant(tenantId: string) {
  return invokePlatformAction<{ ok?: boolean }>(
    { action: 'platform-delete-tenant', tenantId },
    'No se pudo eliminar el negocio.',
  )
}
