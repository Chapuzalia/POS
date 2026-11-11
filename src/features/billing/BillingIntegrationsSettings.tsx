import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { billingCard, billingField } from './TenantBillingPanel'
import { billingRequest } from './service'
import type { BillingIntegrationsStatus, BillingSecretSource } from './types'

const sourceLabel: Record<BillingSecretSource, string> = { stored: 'Guardada aquí', env: 'Variable de entorno del servidor', missing: 'Sin configurar' }
const sourceClass: Record<BillingSecretSource, string> = {
  stored: '!bg-[var(--crm-green-soft)] !text-[var(--crm-green)]',
  env: '!bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]',
  missing: '!bg-[var(--crm-yellow-soft)] !text-[var(--crm-yellow)]',
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <label className="!grid !gap-1.5"><span className="!text-xs !font-semibold !text-[var(--crm-text-secondary)]">{label}</span>{children}{help ? <span className="!text-xs !text-[var(--crm-text-muted)]">{help}</span> : null}</label>
}

function Source({ source, hint }: { source: BillingSecretSource; hint: string | null }) {
  return <span className={`!inline-flex !min-h-6 !items-center !rounded-full !px-2.5 !text-[11px] !font-semibold ${sourceClass[source]}`}>{sourceLabel[source]}{hint ? ` · clave ${hint}` : ''}</span>
}

export default function BillingIntegrationsSettings({ disabled, onBusyChange }: { disabled: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [status, setStatus] = useState<BillingIntegrationsStatus | null>(null)
  const [mollieApiKey, setMollieApiKey] = useState('')
  const [odooUrl, setOdooUrl] = useState('')
  const [odooDb, setOdooDb] = useState('')
  const [odooApiKey, setOdooApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    onBusyChange?.(busy)
    return () => onBusyChange?.(false)
  }, [busy, onBusyChange])

  const apply = useCallback((next: BillingIntegrationsStatus) => {
    setStatus(next); setOdooUrl(next.odoo.serverUrl ?? ''); setOdooDb(next.odoo.db ?? ''); setMollieApiKey(''); setOdooApiKey('')
  }, [])
  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo cargar la configuración.') }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { if (!disabled) void run(async () => apply(await billingRequest<BillingIntegrationsStatus>({ action: 'integrations' }))) }, [disabled, run, apply])

  function save(event: FormEvent<HTMLFormElement>, provider: 'mollie' | 'odoo') {
    event.preventDefault()
    // Empty key fields keep the saved key: keys are write-only and never come back to the browser.
    const changes = provider === 'mollie'
      ? { mollieApiKey: mollieApiKey.trim() }
      : { odooUrl: odooUrl.trim(), odooDb: odooDb.trim(), ...(odooApiKey.trim() ? { odooApiKey: odooApiKey.trim() } : {}) }
    void run(async () => {
      apply(await billingRequest<BillingIntegrationsStatus>({ action: 'integrations-save', ...changes }))
      setMessage(provider === 'mollie' ? 'Clave de Mollie guardada. Los próximos cobros la usarán.' : 'Conexión con Odoo guardada.')
    })
  }

  const locked = disabled || busy
  // Stored Odoo values only apply as a complete set, so the first save needs the key too.
  const odooKeyRequired = status?.odoo.source !== 'stored'
  return <div className="!grid !min-w-0 !max-w-[880px] !gap-6 [&_button]:!min-h-11">
    <header>
      <h2 className="!m-0 !text-2xl !font-bold !tracking-tight">Integraciones</h2>
      <p className="!mb-0 !mt-2 !text-sm !text-[var(--crm-text-muted)]">Claves de acceso de Mollie (cobros) y Odoo (facturas). Las claves guardadas aquí sustituyen a las variables de entorno del servidor y nunca se vuelven a mostrar.</p>
    </header>
    {error ? <p role="alert" className="!m-0 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-red-soft)] !p-4 !text-sm !text-[var(--crm-red)]">{error}</p> : null}
    {message ? <p role="status" className="!m-0 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-green-soft)] !p-4 !text-sm !font-semibold !text-[var(--crm-green)]">{message}</p> : null}
    {status && !status.urlsConfigured ? <p role="status" className="!m-0 !rounded-[var(--crm-radius-md)] !bg-[var(--crm-yellow-soft)] !p-4 !text-sm !text-[var(--crm-yellow)]">Faltan BILLING_APP_URL o BILLING_WEBHOOK_URL (HTTPS) en el servidor. Sin ellas no se puede cobrar aunque la clave de Mollie esté configurada.</p> : null}

    <form className={`${billingCard} !grid !gap-4`} onSubmit={event => save(event, 'mollie')}>
      <div className="!flex !flex-wrap !items-center !justify-between !gap-3">
        <h3 className="!m-0 !text-base !font-bold">Mollie</h3>
        {status ? <div className="!flex !flex-wrap !gap-2"><Source source={status.mollie.source} hint={status.mollie.keyHint} />{status.mollie.mode ? <span className={`!inline-flex !min-h-6 !items-center !rounded-full !px-2.5 !text-[11px] !font-semibold ${status.mollie.mode === 'live' ? '!bg-[var(--crm-red-soft)] !text-[var(--crm-red)]' : '!bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}`}>{status.mollie.mode === 'live' ? 'Cobros reales' : 'Modo prueba'}</span> : null}</div> : null}
      </div>
      <Field label="API key" help="Empieza por live_ (cobros reales) o test_ (pruebas). Cambiarla afecta a todos los cobros y suscripciones de la plataforma.">
        <Input autoComplete="off" className={billingField} disabled={locked} onChange={event => setMollieApiKey(event.target.value)} pattern="(live|test)_[A-Za-z0-9]{20,64}" placeholder={status?.mollie.keyHint ? `Actual ${status.mollie.keyHint}` : 'live_…'} required spellCheck={false} type="password" value={mollieApiKey} />
      </Field>
      <div className="!flex !justify-end"><Button disabled={locked || !mollieApiKey.trim()} type="submit">{busy ? 'Guardando…' : 'Guardar Mollie'}</Button></div>
    </form>

    <form className={`${billingCard} !grid !gap-4`} onSubmit={event => save(event, 'odoo')}>
      <div className="!flex !flex-wrap !items-center !justify-between !gap-3">
        <h3 className="!m-0 !text-base !font-bold">Odoo</h3>
        {status ? <Source source={status.odoo.source} hint={status.odoo.keyHint} /> : null}
      </div>
      <div className="!grid !gap-4 sm:!grid-cols-2">
        <Field label="URL"><Input autoComplete="off" className={billingField} disabled={locked} onChange={event => setOdooUrl(event.target.value)} placeholder="https://empresa.odoo.com" required spellCheck={false} type="url" value={odooUrl} /></Field>
        <Field label="Base de datos"><Input autoComplete="off" className={billingField} disabled={locked} onChange={event => setOdooDb(event.target.value)} required spellCheck={false} value={odooDb} /></Field>
      </div>
      <Field label="API key" help={odooKeyRequired ? 'Clave de API de un usuario de Odoo con permisos de facturación.' : 'Déjala vacía para conservar la clave actual.'}>
        <Input autoComplete="off" className={billingField} disabled={locked} minLength={16} onChange={event => setOdooApiKey(event.target.value)} placeholder={status?.odoo.keyHint ? `Actual ${status.odoo.keyHint}` : ''} required={odooKeyRequired} spellCheck={false} type="password" value={odooApiKey} />
      </Field>
      <div className="!flex !justify-end"><Button disabled={locked || !odooUrl.trim() || !odooDb.trim()} type="submit">{busy ? 'Guardando…' : 'Guardar Odoo'}</Button></div>
    </form>
  </div>
}
