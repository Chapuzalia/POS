import type { TenantContext } from '../../../../types'
import { TenantBillingPanel } from '../../../billing/TenantBillingPanel'

export type PlanCrmProps = {
  disabled: boolean
  tenantContext: TenantContext
}

export function PlanCrm({ disabled, tenantContext }: PlanCrmProps) {
  return <TenantBillingPanel key={tenantContext.tenantId} tenantId={tenantContext.tenantId} disabled={disabled} />
}
