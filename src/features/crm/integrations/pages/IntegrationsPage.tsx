import type { TenantContext } from '../../../../types'
import { LocalFiscalSettings } from '../components/LocalFiscalSettings'
import type { RunAction } from '../../shared/types'
import { hasTenantAddon } from '../../../platform/tenantFeatureAccess'
import { PersonalIntegration } from '../components/PersonalIntegration'

type Props = {
  disabled: boolean
  runAction: RunAction
  tenantContext: TenantContext
}

export function IntegrationsCrm({ disabled, runAction, tenantContext }: Props) {
  return <div className="grid gap-5"><LocalFiscalSettings disabled={disabled} runAction={runAction} tenantContext={tenantContext} />{hasTenantAddon(tenantContext, 'tickit_personal') ? <PersonalIntegration key={tenantContext.tenantId} disabled={disabled} tenantContext={tenantContext} /> : null}</div>
}
