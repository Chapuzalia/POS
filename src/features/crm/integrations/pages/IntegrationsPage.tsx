import type { TenantContext } from '../../../../types'
import { LocalFiscalSettings } from '../components/LocalFiscalSettings'
import type { RunAction } from '../../shared/types'

type Props = {
  disabled: boolean
  runAction: RunAction
  tenantContext: TenantContext
}

export function IntegrationsCrm({ disabled, runAction, tenantContext }: Props) {
  return <LocalFiscalSettings disabled={disabled} runAction={runAction} tenantContext={tenantContext} />
}
