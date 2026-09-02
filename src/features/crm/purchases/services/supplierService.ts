import type { TenantContext } from '../../../../types'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import type { VenueSupplier, VenueSupplierInput } from '../types'

type DbRow = Record<string, unknown>

function mapSupplier(row: DbRow): VenueSupplier {
  return {
    id: String(row.id),
    name: String(row.name),
    taxId: row.tax_id == null ? null : String(row.tax_id),
  }
}

export async function loadVenueSuppliers(
  context: Pick<TenantContext, 'tenantId'>,
  venueId: string,
): Promise<VenueSupplier[]> {
  if (!venueId) return []
  const { data, error } = await requireSupabase().from('suppliers')
    .select('id, name, tax_id')
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', venueId)
    .order('name')
  if (error) throw error
  return ((data ?? []) as DbRow[]).map(mapSupplier)
}

export async function saveVenueSupplier(
  venueId: string,
  input: VenueSupplierInput,
): Promise<VenueSupplier> {
  const { data, error } = await requireSupabase().rpc('save_venue_supplier', {
    p_venue_id: venueId,
    p_name: input.name,
    p_tax_id: input.taxId,
    p_supplier_id: input.id ?? null,
  })
  if (error) throw error
  const result = data as { id: string; name: string; taxId: string | null }
  return { id: result.id, name: result.name, taxId: result.taxId }
}
