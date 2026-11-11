import type { TenantContext } from '../../../../types'
import { TenantBillingPanel } from '../../../billing/TenantBillingPanel'
import { NativeBillingNotice, billingManagedOnWeb } from '../../../billing/NativeBillingNotice'

export type PlanCrmProps = {
  disabled: boolean
  tenantContext: TenantContext
}

export function PlanCrm({ disabled, tenantContext }: PlanCrmProps) {
  if (billingManagedOnWeb) return <NativeBillingNotice />
  return <TenantBillingPanel key={tenantContext.tenantId} tenantId={tenantContext.tenantId} disabled={disabled} />
}
