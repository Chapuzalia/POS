import { supabase } from '../lib/supabase'
import { UserFacingError } from '../utils/UserFacingError.ts'
import { getFunctionInvokeErrorMessage } from '../features/crm/shared/services/crmServiceSupport'

export type FiscalEntityOnboardingInput = {
  tenantId: string
  legalName: string
  taxId: string
  address: string
  postalCode: string
  city: string
  countryCode: string
  venueIds: string[]
  provider: 'verifacti' | 'odoo'
}

export type FiscalEntitySummary = {
  id: string
  legalName: string
  taxId: string
  provider: 'verifacti' | 'odoo'
  provisioningStatus: 'pending' | 'provisioning' | 'ready' | 'error'
  provisioningError: string | null
  venueIds: string[]
  venueNames: string[]
  odooCompanyId: number | null
}

export type FiscalProvider = 'verifacti' | 'odoo'

function client() {
  if (!supabase) throw new UserFacingError('Supabase no está configurado.')
  return supabase
}

export async function loadSuperadminFiscalEntities(tenantId: string) {
  const { data, error } = await client().functions.invoke<{ entities?: FiscalEntitySummary[]; error?: string }>('verifacti-api', {
    body: { action: 'superadmin-list-fiscal-entities', tenantId },
  })
  const message = data?.error
  if (error || message) throw new UserFacingError(await getFunctionInvokeErrorMessage(data, error, 'No se pudieron cargar las entidades fiscales.'))
  return data?.entities ?? []
}

export async function createSuperadminFiscalEntity(input: FiscalEntityOnboardingInput) {
  const { data, error } = await client().functions.invoke<{ entity?: FiscalEntitySummary; error?: string }>('verifacti-api', {
    body: { action: 'superadmin-create-fiscal-entity', ...input },
  })
  const message = data?.error
  if (error || message || !data?.entity) throw new UserFacingError(await getFunctionInvokeErrorMessage(data, error, 'No se pudo crear la entidad fiscal.'))
  return data.entity
}

export async function configureSuperadminFiscalEntity(tenantId: string, entityId: string, provider: FiscalProvider) {
  const { data, error } = await client().functions.invoke<{ entity?: FiscalEntitySummary; error?: string }>('verifacti-api', {
    body: { action: 'superadmin-configure-fiscal-entity', tenantId, entityId, provider },
  })
  const message = data?.error
  if (error || message || !data?.entity) throw new UserFacingError(await getFunctionInvokeErrorMessage(data, error, 'No se pudo configurar el proveedor fiscal.'))
  return data.entity
}

export async function retrySuperadminFiscalEntity(tenantId: string, entityId: string) {
  return configureSuperadminFiscalEntity(tenantId, entityId, 'odoo')
}
