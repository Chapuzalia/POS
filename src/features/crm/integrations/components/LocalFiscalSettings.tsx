import { useCallback, useEffect, useState } from 'react'
import { sileo } from 'sileo'
import { Button as UiButton } from '../../../../components/ui/Button'
import { Checkbox as UiCheckbox } from '../../../../components/ui/Checkbox'
import { Input as UiInput } from '../../../../components/ui/Input'
import type { TenantContext } from '../../../../types'
import { FISCAL_SETTINGS_CHANGED, loadFiscalPosSettings, type FiscalPosSettings } from '../../../fiscal/local/settings'
import { loadVerifactuIntegration, requestVerifactuActivation, saveVerifactuPreferences, type VerifactuIntegration } from '../../../fiscal/local/integration'
import { Field } from '../../shared/components/Field'
import type { RunAction } from '../../shared/types'
import { FiscalSifSetup } from './FiscalSifSetup'

type Props = { disabled: boolean; runAction: RunAction; tenantContext: TenantContext }
const inputClass = '!h-11 !w-full !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !text-[var(--crm-text)]'

export function LocalFiscalSettings({ disabled, runAction, tenantContext }: Props) {
  const canEdit = tenantContext.role === 'owner'
  const [integration, setIntegration] = useState<VerifactuIntegration | null>(null)
  const [settings, setSettings] = useState<FiscalPosSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const state = await loadVerifactuIntegration(tenantContext.tenantId, false)
      const metadata = state.enabled_at ? await loadFiscalPosSettings(tenantContext.tenantId, false) : null
      setIntegration(state); setSettings(metadata); setLoadError(null)
    } catch { setLoadError('No se pudo cargar la integración Verifactu. Reintenta con conexión.') }
  }, [tenantContext.tenantId])

  useEffect(() => {
    setIntegration(null); setSettings(null)
    void runAction(refresh)
    const refreshVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', refreshVisible)
    const timer = window.setInterval(refreshVisible, 15000)
    return () => { window.removeEventListener('focus', refreshVisible); window.clearInterval(timer) }
  }, [refresh, runAction])

  async function request() {
    if (!canEdit || busy) return
    setBusy(true)
    try { await runAction(async () => {
      setIntegration(await requestVerifactuActivation(tenantContext.tenantId))
      sileo.success({ title: 'Verifactu solicitado', description: 'Tu solicitud está pendiente de configuración y activación.' })
    }) } finally { setBusy(false) }
  }
  async function preference(environment: 'test' | 'production', printQr: boolean) {
    if (!canEdit || busy) return
    setBusy(true)
    try { await runAction(async () => {
      setIntegration(await saveVerifactuPreferences(tenantContext.tenantId, environment, printQr))
      window.dispatchEvent(new CustomEvent(FISCAL_SETTINGS_CHANGED, { detail: tenantContext.tenantId }))
    }) } finally { setBusy(false) }
  }
  const current = integration?.tenant_id === tenantContext.tenantId ? integration : null
  const active = Boolean(current?.enabled_at)
  return <div className="!grid !gap-5">
    <section className="!min-w-0 !overflow-hidden !rounded-[16px] !bg-[var(--crm-surface)] !text-[var(--crm-text)] !shadow-[var(--crm-shadow-card)]">
      <header className="!px-[18px] !pt-[18px] !pb-3 md:!px-[22px]">
        <h2 className="!m-0 !text-base !font-bold">Integración con Verifactu</h2>
        <p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">{active ? 'Verifactu está activo. La configuración la gestiona el superadmin.' : 'El POS funciona en modo legacy hasta que se active Verifactu.'}</p>
      </header>
      <div className="!grid !gap-4 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]">
        {loadError ? <div role="alert"><p>{loadError}</p><UiButton disabled={disabled || busy} onClick={() => void runAction(refresh)}>Reintentar</UiButton></div> : null}
        {current ? <>
          <p role="status" className="!m-0 !text-sm !font-semibold !text-[var(--crm-blue)]">{active ? 'Verifactu activo' : current.requested_at ? 'Verifactu solicitado · Pendiente de activación' : 'Verifactu desactivado'}</p>
          {!active && !current.requested_at ? <UiButton className="!min-h-11 !w-fit" variant="primary" disabled={disabled || !canEdit || busy || Boolean(loadError)} onClick={() => void request()}>Solicitar activación Verifactu</UiButton> : null}
          <UiCheckbox checked={current.aeat_environment === 'test'} disabled={disabled || !canEdit || busy || Boolean(loadError)} onChange={checked => void preference(checked ? 'test' : 'production', current.print_ticket_qr)}>Usar URL de pruebas de AEAT para el QR</UiCheckbox>
          {active && settings?.tenant_id === tenantContext.tenantId ? <>
            <div className="!grid !grid-cols-1 !gap-4 lg:!grid-cols-2">
              {([
                ['Razón social del productor SIF', settings.producer_name], ['NIF del productor', settings.producer_nif],
                ['ID de sistema (2 caracteres)', settings.system_id], ['Versión del sistema', settings.system_version],
              ] as const).map(([label, value]) => <Field key={label} label={label}><UiInput className={inputClass} readOnly value={value} /></Field>)}
            </div>
            <UiCheckbox checked={current.print_ticket_qr} disabled={disabled || !canEdit || busy || Boolean(loadError)} onChange={checked => void preference(current.aeat_environment, checked)}>Imprimir código QR en el ticket</UiCheckbox>
          </> : null}
        </> : <p role="status">Cargando integración…</p>}
      </div>
    </section>
    <FiscalSifSetup disabled={disabled} runAction={runAction} tenantContext={tenantContext} />
  </div>
}
