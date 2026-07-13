import { supabase } from '../lib/supabase'

export type PlatformTenant = {
  id: string
  name: string
  slug: string
  createdAt: string
  venueCount: number
  owner: {
    email: string
    fullName: string
    isActive: boolean
  } | null
}

export type CreatePlatformTenantInput = {
  tenantName: string
  tenantSlug: string
  venueName: string
  ownerEmail: string
  ownerPassword: string
  ownerFullName: string
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
    throw new Error(functionError ?? error?.message ?? 'No se pudieron cargar los negocios.')
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
    throw new Error(functionError ?? error?.message ?? 'No se pudo crear el negocio.')
  }
  if (!data?.tenant) {
    throw new Error('La funcion no devolvio el negocio creado.')
  }
  return data.tenant
}
