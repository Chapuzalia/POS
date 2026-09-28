import type { TenantContext } from '../../../../types'
import { FiscalSifSetup } from '../components/FiscalSifSetup'
import { LocalFiscalSettings } from '../components/LocalFiscalSettings'
import type { RunAction } from '../../shared/types'

type Props = {
  disabled: boolean
  runAction: RunAction
  tenantContext: TenantContext
}

export function IntegrationsCrm({ disabled, runAction, tenantContext }: Props) {
  return <div className="!grid !gap-5"><FiscalSifSetup disabled={disabled} runAction={runAction} tenantContext={tenantContext} /><LocalFiscalSettings disabled={disabled} runAction={runAction} tenantContext={tenantContext} /></div>
}
