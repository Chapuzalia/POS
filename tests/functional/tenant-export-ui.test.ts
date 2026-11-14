import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { compileComponent, createCompiledHookRunner, jsxRuntime, nodes } from '../helpers/component-harness.mjs'

const read = (path: string) => readFileSync(new URL(`../../src/features/crm/${path}`, import.meta.url), 'utf8')
it('exposes the export to owners from Documentation and Mi plan, including the native billing notice', () => {
  const { DocumentationCrm } = compileComponent(read('documentation/pages/DocumentationPage.tsx'), {
    'react/jsx-runtime': jsxRuntime, 'lucide-react': { BookOpen: 'icon', Download: 'icon', FileText: 'icon' },
    '../../../../components/ui/Button': { Button: 'button' },
    '../documentationCatalog': { legalDocuments: [], userManuals: [] }, '../TenantDataExport': { TenantDataExport: 'data-export' },
  })
  for (const role of ['owner','manager','cashier','gestor']) {
    const tree = DocumentationCrm({ canStartOnboarding: false, onStartOnboarding: vi.fn(), tenantContext: { tenantId: 'tenant', role } })
    expect(nodes(tree).some(node => node.type === 'data-export')).toBe(role === 'owner')
  }
  for (const native of [false,true]) {
    const { PlanCrm } = compileComponent(read('plan/pages/PlanPage.tsx'), {
      'react/jsx-runtime': jsxRuntime,
      '../../../billing/TenantBillingPanel': { TenantBillingPanel: 'billing-panel' },
      '../../../billing/NativeBillingNotice': { NativeBillingNotice: 'native-notice', billingManagedOnWeb: native },
      '../../documentation/TenantDataExport': { TenantDataExport: 'data-export' },
    })
    expect(nodes(PlanCrm({ disabled: true, tenantContext: { tenantId: 'tenant', role: 'owner' } })).find(node => node.type === 'data-export')?.props.tenantId).toBe('tenant')
    expect(nodes(PlanCrm({ disabled: false, tenantContext: { tenantId: 'tenant', role: 'manager' } })).some(node => node.type === 'data-export')).toBe(false)
  }
})

it('disables repeated downloads while busy and shows a recoverable error after failure', async () => {
  let rejectDownload: (error: Error) => void = () => {}
  const download = vi.fn(() => new Promise((_resolve, reject) => { rejectDownload = reject }))
  const runner = createCompiledHookRunner(read('documentation/TenantDataExport.tsx'), 'TenantDataExport', {
    'react/jsx-runtime': jsxRuntime, 'lucide-react': { Download: 'icon' },
    '../../../components/ui/Button': { Button: 'button' },
    '../../../utils/errors': { getReadableError: (error: Error) => error.message },
    './tenantExportService': { downloadTenantExport: download },
  })
  const render = () => runner.render({ tenantId: 'tenant' })
  nodes(render()).find(node => node.type === 'button')?.props.onClick()
  expect(nodes(render()).find(node => node.type === 'button')?.props.disabled).toBe(true)
  nodes(render()).find(node => node.type === 'button')?.props.onClick()
  expect(download).toHaveBeenCalledTimes(1)
  expect(download.mock.calls[0][0]).toBe('tenant')
  rejectDownload(new Error('No se ha podido descargar un fichero.'))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(nodes(render()).find(node => node.props?.role === 'alert')?.props.children).toContain('No se ha podido descargar')
  expect(nodes(render()).find(node => node.type === 'button')?.props.disabled).toBe(false)
})
