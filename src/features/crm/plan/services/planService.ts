import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { type TenantContext } from '../../../../types'

export type CrmPlan = {
  limits: {
    devices: number
    venues: number
  }
  usage: {
    devices: number
    venues: number
  }
}

export async function loadCrmPlan(context: TenantContext): Promise<CrmPlan> {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke<CrmPlan & { error?: string }>('manage-pos-users', {
    body: { action: 'tenant-plan', tenantId: context.tenantId },
  })

  if (error || data?.error) {
    throw new Error(data?.error ?? error?.message ?? 'No se pudo cargar la información del plan.')
  }
  if (!data?.limits || !data.usage) {
    throw new Error('La función no devolvió la información del plan.')
  }
  return data
}
