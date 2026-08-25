import type { TenantContext } from '../../../../types'
import { getFunctionInvokeErrorMessage, requireSupabase } from '../../shared/services/crmServiceSupport'

export type ProductionDestination = {
  id: string
  name: string
  isActive: boolean
  sortOrder: number
  kdsEnabled: boolean
  printerId: string | null
}

export type ProductionRoute = { sourceId: string; destinationId: string }
export type ProductionAgent = {
  id: string
  isActive: boolean
  version: string | null
  workerState: string
  productionCapability: boolean
  lastSeenAt: string | null
}
export type ProductionPrinter = { printerId: string; displayName: string; available: boolean; paperWidth: number; characterSet: string }
export type ProductionDispatch = { id: string; printerId: string; status: string; errorMessage: string | null; createdAt: string }
export type ProductionKdsDevice = { id: string; name: string; destinationId: string; isActive: boolean }

export type ProductionAdminState = {
  venueEnabled: boolean
  destinations: ProductionDestination[]
  categoryRoutes: ProductionRoute[]
  productRoutes: ProductionRoute[]
  agent: ProductionAgent | null
  printers: ProductionPrinter[]
  dispatches: ProductionDispatch[]
  kdsDevices: ProductionKdsDevice[]
}

export async function loadProductionAdmin(context: TenantContext, venueId: string): Promise<ProductionAdminState> {
  const client = requireSupabase()
  const [venue, destinations, categoryRoutes, productRoutes, agents, printers, dispatches, kdsDevices] = await Promise.all([
    client.from('venues').select('production_enabled').eq('tenant_id', context.tenantId).eq('id', venueId).single(),
    client.from('production_destinations').select('id, name, is_active, sort_order, kds_enabled, printer_id').eq('tenant_id', context.tenantId).eq('venue_id', venueId).order('sort_order'),
    client.from('production_category_routes').select('category_id, destination_id').eq('tenant_id', context.tenantId).eq('venue_id', venueId),
    client.from('production_product_routes').select('product_id, destination_id').eq('tenant_id', context.tenantId).eq('venue_id', venueId),
    client.from('production_print_agents').select('id, is_active, version, worker_state, production_capability, last_seen_at').eq('tenant_id', context.tenantId).eq('venue_id', venueId).maybeSingle(),
    client.from('production_agent_printers').select('printer_id, display_name, available, paper_width, character_set').eq('tenant_id', context.tenantId).eq('venue_id', venueId).order('display_name'),
    client.from('production_printer_dispatches').select('id, printer_id, status, error_message, created_at').eq('tenant_id', context.tenantId).eq('venue_id', venueId).order('created_at', { ascending: false }).limit(30),
    client.from('devices').select('id, name, production_destination_id, is_active').eq('tenant_id', context.tenantId).eq('venue_id', venueId).eq('device_mode', 'kds').order('name'),
  ])
  const failure = [venue, destinations, categoryRoutes, productRoutes, agents, printers, dispatches, kdsDevices].find((result) => result.error)?.error
  if (failure) throw failure
  return {
    venueEnabled: venue.data?.production_enabled === true,
    destinations: (destinations.data ?? []).map((row) => ({ id: row.id, name: row.name, isActive: row.is_active, sortOrder: row.sort_order, kdsEnabled: row.kds_enabled, printerId: row.printer_id })),
    categoryRoutes: (categoryRoutes.data ?? []).map((row) => ({ sourceId: row.category_id, destinationId: row.destination_id })),
    productRoutes: (productRoutes.data ?? []).map((row) => ({ sourceId: row.product_id, destinationId: row.destination_id })),
    agent: agents.data ? { id: agents.data.id, isActive: agents.data.is_active, version: agents.data.version, workerState: agents.data.worker_state, productionCapability: agents.data.production_capability, lastSeenAt: agents.data.last_seen_at } : null,
    printers: (printers.data ?? []).map((row) => ({ printerId: row.printer_id, displayName: row.display_name, available: row.available, paperWidth: row.paper_width, characterSet: row.character_set })),
    dispatches: (dispatches.data ?? []).map((row) => ({ id: row.id, printerId: row.printer_id, status: row.status, errorMessage: row.error_message, createdAt: row.created_at })),
    kdsDevices: (kdsDevices.data ?? []).map((row) => ({ id: row.id, name: row.name, destinationId: row.production_destination_id, isActive: row.is_active })),
  }
}

export async function setVenueProductionEnabled(venueId: string, enabled: boolean) {
  const { error } = await requireSupabase().rpc('set_venue_production_enabled', { p_venue_id: venueId, p_enabled: enabled })
  if (error) throw error
}

export async function saveProductionDestination(context: TenantContext, venueId: string, input: ProductionDestination) {
  const row = { tenant_id: context.tenantId, venue_id: venueId, id: input.id, name: input.name.trim(), is_active: input.isActive, sort_order: input.sortOrder, kds_enabled: input.kdsEnabled, printer_id: input.printerId || null, updated_at: new Date().toISOString() }
  const { error } = await requireSupabase().from('production_destinations').upsert(row)
  if (error) throw error
}

export async function deleteProductionDestination(context: TenantContext, id: string) {
  const { error } = await requireSupabase().from('production_destinations').delete().eq('tenant_id', context.tenantId).eq('id', id)
  if (error) throw error
}

export async function saveProductionRoute(context: TenantContext, venueId: string, kind: 'category' | 'product', sourceId: string, destinationId: string | null) {
  const table = kind === 'category' ? 'production_category_routes' : 'production_product_routes'
  const sourceColumn = kind === 'category' ? 'category_id' : 'product_id'
  const query = requireSupabase().from(table)
  if (!destinationId) {
    const { error } = await query.delete().eq('tenant_id', context.tenantId).eq('venue_id', venueId).eq(sourceColumn, sourceId)
    if (error) throw error
    return
  }
  const { error } = await query.upsert({ tenant_id: context.tenantId, venue_id: venueId, [sourceColumn]: sourceId, destination_id: destinationId, updated_at: new Date().toISOString() })
  if (error) throw error
}

export async function createKdsDevice(context: TenantContext, venueId: string, destinationId: string, deviceName: string) {
  const { data, error } = await requireSupabase().functions.invoke<{ credentials?: { email: string; password: string }; error?: string }>('manage-pos-users', {
    body: { action: 'create-kds-device', tenantId: context.tenantId, venueId, productionDestinationId: destinationId, deviceName: deviceName.trim() },
  })
  if (error || data?.error) throw new Error(await getFunctionInvokeErrorMessage(data, error, 'No se pudo crear el KDS.'))
  if (!data?.credentials) throw new Error('No se recibieron las credenciales del KDS.')
  return data.credentials
}

export async function deleteKdsDevice(context: TenantContext, deviceId: string) {
  const { data, error } = await requireSupabase().functions.invoke<{ error?: string }>('manage-pos-users', {
    body: { action: 'delete-device', tenantId: context.tenantId, deviceId },
  })
  if (error || data?.error) throw new Error(await getFunctionInvokeErrorMessage(data, error, 'No se pudo eliminar el KDS.'))
}

export async function createAgentPairingCode(venueId: string) {
  const { data, error } = await requireSupabase().rpc('create_print_agent_pairing_code', { p_venue_id: venueId })
  if (error) throw error
  return data as { code: string; expiresAt: string }
}

export async function unlinkAgent(venueId: string) {
  const { error } = await requireSupabase().rpc('unlink_print_agent', { p_venue_id: venueId })
  if (error) throw error
}

export async function reprintDispatch(dispatchId: string, printerId?: string) {
  const { error } = await requireSupabase().rpc('reprint_production_dispatch', { p_dispatch_id: dispatchId, p_printer_id: printerId ?? null })
  if (error) throw error
}
