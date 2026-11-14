import type { TenantContext } from '../../../../types'
import { TenantBillingPanel } from '../../../billing/TenantBillingPanel'
import { NativeBillingNotice, billingManagedOnWeb } from '../../../billing/NativeBillingNotice'
import { TenantDataExport } from '../../documentation/TenantDataExport'

export type PlanCrmProps = {
  disabled: boolean
  tenantContext: TenantContext
}

export function PlanCrm({ disabled, tenantContext }: PlanCrmProps) {
  return <div className="grid gap-5">
    {billingManagedOnWeb ? <NativeBillingNotice /> : <TenantBillingPanel key={tenantContext.tenantId} tenantId={tenantContext.tenantId} disabled={disabled} />}
    {tenantContext.role === 'owner' ? <TenantDataExport key={tenantContext.tenantId} tenantId={tenantContext.tenantId} /> : null}
  </div>
}
