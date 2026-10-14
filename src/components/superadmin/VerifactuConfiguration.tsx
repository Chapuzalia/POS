import { useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { supabase } from '../../lib/supabase'
import { loadVerifactuIntegration, configureVerifactuIntegration, type VerifactuIntegration } from '../../features/fiscal/local/integration'
import { rememberFiscalPosSettings, type FiscalPosSettings } from '../../features/fiscal/local/settings'

type Props = { tenantId: string; disabled: boolean; runAction: (action: () => Promise<void>) => Promise<void>; onSaved: () => Promise<void> }
const inputClass = '!h-11 !w-full !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px]'

export function VerifactuConfiguration({ tenantId, disabled, runAction, onSaved }: Props) {
  const [integration, setIntegration] = useState<VerifactuIntegration | null>(null)
  const [settings, setSettings] = useState<FiscalPosSettings>({ tenant_id: tenantId, bridge_url: '', aeat_environment: 'production',
    print_ticket_qr: true, producer_name: '', producer_nif: '', system_id: '', system_version: '' })
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    setLoaded(false)
    void runAction(async () => {
      if (!supabase) throw new Error('Supabase no está configurado.')
      const [state, result] = await Promise.all([
        loadVerifactuIntegration(tenantId, false),
        supabase.from('fiscal_pos_bridge_settings').select('*').eq('tenant_id', tenantId).maybeSingle(),
      ])
      if (result.error) throw result.error
      if (!alive) return
      setIntegration(state)
      setSettings(result.data ? rememberFiscalPosSettings(result.data, tenantId) : {
        tenant_id: tenantId, bridge_url: '', aeat_environment: state.aeat_environment, print_ticket_qr: state.print_ticket_qr,
        producer_name: '', producer_nif: '', system_id: '', system_version: '',
      })
      setLoaded(true)
    })
    return () => { alive = false }
  }, [tenantId, runAction])

  async function save(activate: boolean) {
    if (!loaded || disabled) return
    await runAction(async () => {
      setIntegration(await configureVerifactuIntegration(settings, activate))
      await onSaved()
    })
  }
  return <section className="!grid !gap-3 !rounded-[12px] !border !border-[var(--crm-border-subtle)] !p-4">
    <h3 className="!m-0 !text-sm !font-bold">Integración con Verifactu</h3>
    {!loaded ? <p role="status">Cargando configuración…</p> : !integration?.requested_at ? <p className="!text-xs !text-[var(--crm-text-muted)]">El cliente todavía no ha solicitado Verifactu.</p> : <>
      <p role="status" className="!m-0 !text-xs !font-semibold !text-[var(--crm-blue)]">{integration.enabled_at ? 'Verifactu activo' : 'Verifactu solicitado · Pendiente de activación'}</p>
      <form className="!grid !gap-4 sm:!grid-cols-2" onSubmit={event => { event.preventDefault(); void save(false) }}>
        {([
          ['bridge_url', 'URL del puente VPS', 255], ['producer_name', 'Razón social del productor SIF', 120],
          ['producer_nif', 'NIF del productor', 9], ['system_id', 'ID de sistema (2 caracteres)', 2], ['system_version', 'Versión del sistema', 40],
        ] as const).map(([field, label, maxLength]) => <label key={field} className="!grid !gap-1.5 !text-xs">
          {label}<Input className={inputClass} disabled={disabled} maxLength={maxLength} required={field !== 'bridge_url'} type={field === 'bridge_url' ? 'url' : 'text'}
            value={settings[field]} onChange={event => setSettings(current => ({ ...current, [field]: event.target.value }))} />
        </label>)}
        <div className="!col-span-full !flex !flex-wrap !justify-end !gap-2">
          <Button className="!min-h-11" disabled={disabled} type="submit">Guardar configuración</Button>
          {!integration.enabled_at ? <Button className="!min-h-11" variant="primary" disabled={disabled || !settings.bridge_url.trim()} type="button" onClick={() => void save(true)}>Guardar y activar Verifactu</Button> : null}
        </div>
      </form>
    </>}
  </section>
}
