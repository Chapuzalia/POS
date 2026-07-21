import { isValidTaxRate } from '../../../../lib/tax'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { type CrmDevice, type CrmPosUser, type CrmVenue, type DeviceMode, type TenantContext } from '../../../../types'

export type CrmAccessData = {
  venues: CrmVenue[]
  devices: CrmDevice[]
  users: CrmPosUser[]
}

export async function loadCrmAccessData(context: TenantContext): Promise<CrmAccessData> {
  const client = requireSupabase()
  const [{ data: venueRows, error: venuesError }, { data: deviceRows, error: devicesError }, usersResult] =
    await Promise.all([
      client
        .from('venues')
        .select('id, name, address, legal_name, tax_id, sort_order, is_active, tables_enabled, default_tax_rate')
        .eq('tenant_id', context.tenantId)
        .order('sort_order'),
      client
        .from('devices')
        .select('id, venue_id, name, is_active, device_mode, default_cash_register_id')
        .eq('tenant_id', context.tenantId)
        .order('name'),
      client.functions.invoke<{ users: CrmPosUser[] }>('manage-pos-users', {
        body: { action: 'list', tenantId: context.tenantId },
      }),
    ])

  if (venuesError || devicesError || usersResult.error) {
    throw venuesError ?? devicesError ?? usersResult.error
  }

  const functionError = (usersResult.data as { error?: string } | null)?.error
  if (functionError) {
    throw new Error(functionError)
  }

  return {
    venues: (venueRows ?? []).map((venue) => ({
      id: venue.id as string,
      name: venue.name as string,
      address: (venue.address as string | null) ?? '',
      legalName: (venue.legal_name as string | null) ?? '',
      taxId: (venue.tax_id as string | null) ?? '',
      sortOrder: venue.sort_order as number,
      isActive: venue.is_active as boolean,
      tablesEnabled: venue.tables_enabled as boolean,
      defaultTaxRate: Number(venue.default_tax_rate),
    })),
    devices: (deviceRows ?? []).map((device) => ({
      id: device.id as string,
      venueId: device.venue_id as string,
      name: device.name as string,
      isActive: device.is_active as boolean,
      deviceMode: device.device_mode as DeviceMode,
      defaultCashRegisterId: device.default_cash_register_id as string | null,
    })),
    users: usersResult.data?.users ?? [],
  }
}

export async function loadCrmVenues(context: TenantContext): Promise<CrmVenue[]> {
  const client = requireSupabase()
  const { data, error } = await client
    .from('venues')
    .select('id, name, address, legal_name, tax_id, sort_order, is_active, tables_enabled, default_tax_rate')
    .eq('tenant_id', context.tenantId)
    .order('sort_order')

  if (error) {
    throw error
  }

  return (data ?? []).map((venue) => ({
    id: venue.id as string,
    name: venue.name as string,
    address: (venue.address as string | null) ?? '',
    legalName: (venue.legal_name as string | null) ?? '',
    taxId: (venue.tax_id as string | null) ?? '',
    sortOrder: venue.sort_order as number,
    isActive: venue.is_active as boolean,
    tablesEnabled: venue.tables_enabled as boolean,
    defaultTaxRate: Number(venue.default_tax_rate),
  }))
}

export async function createCrmVenue(context: TenantContext, name: string) {
  const client = requireSupabase()
  const { error } = await client.from('venues').insert({
    tenant_id: context.tenantId,
    name: name.trim(),
    sort_order: 0,
    is_active: true,
  })

  if (error) {
    throw error
  }
}

export async function updateCrmVenueDefaultTaxRate(
  context: TenantContext,
  venueId: string,
  defaultTaxRate: number,
) {
  if (!isValidTaxRate(defaultTaxRate)) {
    throw new Error('El tipo de IVA debe estar entre 0 y 100.')
  }

  const { error } = await requireSupabase()
    .from('venues')
    .update({ default_tax_rate: defaultTaxRate })
    .eq('tenant_id', context.tenantId)
    .eq('id', venueId)

  if (error) {
    throw error
  }
}

export type CrmVenueSettingsInput = {
  address: string
  defaultTaxRate: number
  legalName: string
  taxId: string
}

export async function updateCrmVenueSettings(
  context: TenantContext,
  venueId: string,
  input: CrmVenueSettingsInput,
) {
  if (!isValidTaxRate(input.defaultTaxRate)) {
    throw new Error('El tipo de IVA debe estar entre 0 y 100.')
  }

  const address = input.address.trim()
  const legalName = input.legalName.trim()
  const taxId = input.taxId.trim()

  if (address.length > 300) {
    throw new Error('La direcci\u00f3n no puede superar los 300 caracteres.')
  }
  if (legalName.length > 80) {
    throw new Error('La raz\u00f3n social no puede superar los 80 caracteres.')
  }
  if (taxId.length > 80) {
    throw new Error('El NIF/CIF no puede superar los 80 caracteres.')
  }

  const { error } = await requireSupabase()
    .from('venues')
    .update({
      address: address || null,
      default_tax_rate: input.defaultTaxRate,
      legal_name: legalName || null,
      tax_id: taxId || null,
    })
    .eq('tenant_id', context.tenantId)
    .eq('id', venueId)

  if (error) {
    throw error
  }

}

export async function createCrmDevice(context: TenantContext, venueId: string, name: string, deviceMode: DeviceMode) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{
    credentials?: { email: string; password: string }
    error?: string
  }>('manage-pos-users', {
    body: {
      action: 'create-device-with-user',
      deviceMode,
      deviceName: name.trim(),
      tenantId: context.tenantId,
      venueId,
    },
  })

  if (error || data?.error || !data?.credentials) {
    throw new Error(data?.error ?? error?.message ?? 'No se pudieron crear el dispositivo y su usuario.')
  }
  return data.credentials
}

export async function setCrmPosUserActive(context: TenantContext, userId: string, isActive: boolean) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'set-active', tenantId: context.tenantId, userId, isActive },
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }
}

export async function releaseCrmPosUserLogin(context: TenantContext, userId: string) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'release-login', tenantId: context.tenantId, userId },
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }
}

export async function updateCrmPosUser(
  context: TenantContext,
  userId: string,
  input: { deviceId: string; deviceMode: DeviceMode; email: string; fullName: string; password?: string },
) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'update', tenantId: context.tenantId, userId, ...input },
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }
}

export async function deleteCrmPosUser(context: TenantContext, userId: string) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'delete', tenantId: context.tenantId, userId },
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }
}
