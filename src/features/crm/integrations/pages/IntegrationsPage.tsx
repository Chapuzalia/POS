import { Button as UiButton } from '../../../../components/ui/Button'
import { Checkbox as UiCheckbox } from '../../../../components/ui/Checkbox'
import { Input as UiInput } from '../../../../components/ui/Input'
import { CheckCircle2, Clipboard, KeyRound, PlugZap, RefreshCw, Save, ShieldCheck } from 'lucide-react'
import { sileo } from 'sileo'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { TenantContext } from '../../../../types'
import { Field } from '../../shared/components/Field'
import { CrmSelect } from '../../shared/components/CrmSelect'
import type { RunAction } from '../../shared/types'
import {
  type FiscalEnvironment,
  type FiscalProvider,
  type FiscalIntegrationProvider,
  loadFiscalEntityConfiguration,
  saveFiscalEntityConfiguration,
  listFiscalIncidents,
  retryFiscalOperation,
  type FiscalIncident,
  type VerifactiConfiguration,
  loadVerifactiConfiguration,
  saveVerifactiConfiguration,
  testVerifactiConnection,
} from '../services/verifactiService'

type Props = {
  disabled: boolean
  runAction: RunAction
  tenantContext: TenantContext
}

const inputClass = '!h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none focus:!border-[var(--crm-blue)] focus:!shadow-[0_0_0_3px_var(--crm-blue-soft)]'

export function IntegrationsCrm({ disabled, runAction, tenantContext }: Props) {
  const canEdit = tenantContext.role === 'owner'
  const formDisabled = disabled || !canEdit
  const [configuration, setConfiguration] = useState<VerifactiConfiguration | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [provider, setProvider] = useState<FiscalProvider>('verifactu')
  const [integrationProvider, setIntegrationProvider] = useState<FiscalIntegrationProvider>('verifacti')
  const [legalName, setLegalName] = useState('')
  const [taxId, setTaxId] = useState('')
  const [odooBridgeUrl, setOdooBridgeUrl] = useState('')
  const [odooEntityReference, setOdooEntityReference] = useState('')
  const [bridgeSecret, setBridgeSecret] = useState('')
  const [incidents, setIncidents] = useState<FiscalIncident[]>([])
  const [environment, setEnvironment] = useState<FiscalEnvironment>('test')
  const [apiKey, setApiKey] = useState('')
  const [managementApiKey, setManagementApiKey] = useState('')
  const [automaticSubmission, setAutomaticSubmission] = useState(true)
  const [webhooksEnabled, setWebhooksEnabled] = useState(false)

  const applyConfiguration = useCallback((value: VerifactiConfiguration) => {
    setConfiguration(value)
    setEnabled(value.enabled)
    setProvider(value.provider)
    setIntegrationProvider(value.integrationProvider ?? 'verifacti')
    setLegalName(value.legalName ?? '')
    setTaxId(value.taxId ?? '')
    setOdooBridgeUrl(value.odooBridgeUrl ?? '')
    setOdooEntityReference(value.odooEntityReference ?? '')
    setEnvironment(value.environment)
    setAutomaticSubmission(value.automaticSubmission)
    setWebhooksEnabled(value.webhooksEnabled)
    setApiKey('')
    setManagementApiKey('')
  }, [])

  const refresh = useCallback(async () => {
    const [legacy, entity, incidentResult] = await Promise.all([loadVerifactiConfiguration(tenantContext), loadFiscalEntityConfiguration(tenantContext), listFiscalIncidents(tenantContext)])
    applyConfiguration({ ...legacy, ...entity })
    setIncidents(incidentResult.incidents ?? [])
  }, [applyConfiguration, tenantContext])

  useEffect(() => { void runAction(refresh) }, [refresh, runAction])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canEdit) return
    await runAction(async () => {
      const saved = await saveFiscalEntityConfiguration(tenantContext, {
        legalName, taxId, provider: integrationProvider, taxSystem: provider, environment, enabled, automaticSubmission,
        ...(odooBridgeUrl.trim() ? { odooBridgeUrl: odooBridgeUrl.trim() } : {}),
        ...(odooEntityReference.trim() ? { odooEntityReference: odooEntityReference.trim() } : {}),
        ...(bridgeSecret.trim() ? { bridgeSecret: bridgeSecret.trim() } : {}),
      })
      if (integrationProvider === 'verifacti') {
        await saveVerifactiConfiguration(tenantContext, {
          enabled, provider, environment, automaticSubmission, webhooksEnabled,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(managementApiKey.trim() ? { managementApiKey: managementApiKey.trim() } : {}),
        })
      }
      applyConfiguration(saved)
      setBridgeSecret('')
      sileo.success({ title: 'Integración guardada', description: 'Las credenciales se cifran y solo se utilizan desde el backend.' })
    })
  }

  async function testConnection() {
    if (!canEdit) return
    await runAction(async () => {
      const result = await testVerifactiConnection(tenantContext)
      await refresh()
      sileo.success({ title: 'Conexión correcta', description: result.nif ? `API activa para ${result.nif}.` : 'La API de Verifacti está disponible.' })
    })
  }

  async function copyWebhookUrl() {
    if (!configuration?.webhookUrl) return
    await navigator.clipboard.writeText(configuration.webhookUrl)
    sileo.success({ title: 'URL copiada' })
  }

  const connectionTone = configuration?.connectionStatus === 'connected'
    ? '!bg-[var(--crm-green-soft)] !text-[var(--crm-green)]'
    : configuration?.connectionStatus === 'error'
      ? '!bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'
      : '!bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]'

  return (
    <section className="!min-w-0 !overflow-hidden !rounded-2xl !bg-[var(--crm-surface)] !text-[var(--crm-text)] !shadow-[var(--crm-shadow-card)]">
      <header className="!flex !items-start !gap-3 !px-[18px] !pt-[18px] !pb-3 md:!px-[22px]">
        <div className="!grid !size-11 !shrink-0 !place-items-center !rounded-xl !bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]">
          <PlugZap className="!size-5" />
        </div>
        <div className="!min-w-0 !flex-1">
          <div className="!flex !flex-wrap !items-center !gap-2">
            <h2 className="!m-0 !text-base !font-bold">Fiscalidad</h2>
            <span className={`!inline-flex !min-h-6 !items-center !rounded-full !px-2.5 !text-[11px] !font-semibold ${connectionTone}`}>
              {configuration?.connectionStatus === 'connected' ? 'Conectado' : configuration?.connectionStatus === 'error' ? 'Error de conexión' : 'Sin probar'}
            </span>
          </div>
          <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">Fiscalización por entidad mediante Verifacti u Odoo.</p>
        </div>
      </header>

      <form className="!grid !gap-5 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]" onSubmit={(event) => void submit(event)}>
        {!canEdit ? <p className="!m-0 !rounded-xl !bg-[var(--crm-blue-soft)] !px-4 !py-3 !text-xs !font-semibold !text-[var(--crm-blue)]">Puedes consultar la integración. Solo el owner puede modificar las claves y la configuración.</p> : null}
          <div className="!grid !grid-cols-1 !gap-4 lg:!grid-cols-2">
            <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4 lg:!col-span-2">
              <div className="!grid !grid-cols-1 !gap-3 sm:!grid-cols-2">
                <Field label="Nombre legal"><UiInput className={inputClass} disabled={formDisabled} onChange={(event) => setLegalName(event.target.value)} value={legalName} /></Field>
                <Field label="NIF / CIF"><UiInput className={inputClass} disabled={formDisabled} onChange={(event) => setTaxId(event.target.value)} value={taxId} /></Field>
                <Field label="Proveedor de integración"><CrmSelect disabled={formDisabled} onChange={(value) => setIntegrationProvider(value as FiscalIntegrationProvider)} options={[{ label: 'Verifacti', value: 'verifacti' }, { label: 'Odoo', value: 'odoo' }]} value={integrationProvider} /></Field>
              </div>
              {integrationProvider === 'odoo' ? <div className="!grid !grid-cols-1 !gap-3 sm:!grid-cols-2"><Field label="URL del puente Odoo"><UiInput className={inputClass} disabled={formDisabled} onChange={(event) => setOdooBridgeUrl(event.target.value)} value={odooBridgeUrl} /></Field><Field label="Referencia de empresa"><UiInput className={inputClass} disabled={formDisabled} onChange={(event) => setOdooEntityReference(event.target.value)} value={odooEntityReference} /></Field><Field label="Secreto del puente"><UiInput autoComplete="new-password" className={inputClass} disabled={formDisabled} onChange={(event) => setBridgeSecret(event.target.value)} placeholder="No se muestra el secreto guardado" type="password" value={bridgeSecret} /></Field></div> : null}
            </div>

          {integrationProvider === 'verifacti' ? <div className="!grid !content-start !gap-4 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4">
            <UiCheckbox checked={enabled} disabled={formDisabled} onChange={setEnabled}>Activar integración</UiCheckbox>
            <div className="!grid !grid-cols-1 !gap-3 sm:!grid-cols-2">
              <Field label="Sistema">
                <CrmSelect disabled={formDisabled} onChange={(value) => setProvider(value as FiscalProvider)} options={[{ label: 'VeriFactu', value: 'verifactu' }, { label: 'TicketBAI', value: 'ticketbai' }]} value={provider} />
              </Field>
              <Field label="Entorno">
                <CrmSelect disabled={formDisabled} onChange={(value) => setEnvironment(value as FiscalEnvironment)} options={[{ label: 'Pruebas', value: 'test' }, { label: 'Produccion', value: 'production' }]} value={environment} />
              </Field>
            </div>
            <Field label="API key">
              <div className="!relative">
                <KeyRound className="!pointer-events-none !absolute !top-1/2 !left-3 !size-4 !-translate-y-1/2 !text-[var(--crm-text-muted)]" />
                <UiInput autoComplete="new-password" className={`${inputClass} !pl-10`} disabled={formDisabled} onChange={(event) => setApiKey(event.target.value)} placeholder={configuration?.hasApiKey ? 'Clave guardada (escribe para sustituirla)' : 'Pega tu API key'} type="password" value={apiKey} />
              </div>
            </Field>
            <Field label="API key de gestión (webhooks)">
              <div className="!relative">
                <KeyRound className="!pointer-events-none !absolute !top-1/2 !left-3 !size-4 !-translate-y-1/2 !text-[var(--crm-text-muted)]" />
                <UiInput autoComplete="new-password" className={`${inputClass} !pl-10`} disabled={formDisabled} onChange={(event) => setManagementApiKey(event.target.value)} placeholder={configuration?.hasManagementApiKey ? 'Clave de gestión guardada (escribe para sustituirla)' : 'Necesaria para registrar webhooks'} type="password" value={managementApiKey} />
              </div>
            </Field>
            <p className="!m-0 !flex !items-start !gap-2 !text-xs !leading-5 !text-[var(--crm-text-muted)]"><ShieldCheck className="!mt-0.5 !size-4 !shrink-0" />La clave se envía una sola vez al backend, se cifra con AES-GCM y nunca vuelve al navegador.</p>
          </div> : <div className="!grid !content-start !gap-4 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4"><UiCheckbox checked={enabled} disabled={formDisabled} onChange={setEnabled}>Activar integración</UiCheckbox><p className="!m-0 !text-xs !leading-5 !text-[var(--crm-text-muted)]">Odoo asignará la numeración, el estado y el QR fiscal definitivos. Tickit no reconstruye contenido Veri*Factu.</p></div>}

          <div className="!grid !content-start !gap-4 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4">
            <UiCheckbox checked={automaticSubmission} disabled={formDisabled} onChange={setAutomaticSubmission}>Enviar automáticamente al emitir facturas</UiCheckbox>
            <UiCheckbox checked={webhooksEnabled} disabled={formDisabled} onChange={setWebhooksEnabled}>Activar webhooks de confirmación</UiCheckbox>
            <Field label="URL del webhook">
              <div className="!flex !gap-2">
                <UiInput className={`${inputClass} !font-mono !text-xs`} readOnly value={configuration?.webhookUrl ?? ''} />
                <UiButton aria-label="Copiar URL del webhook" className="!grid !size-11 !min-h-11 !min-w-11 !place-items-center !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !p-0 !text-[var(--crm-text-secondary)]" onClick={() => void copyWebhookUrl()} type="button"><Clipboard className="!size-4" /></UiButton>
              </div>
            </Field>
            {configuration?.connectionError ? <p className="!m-0 !rounded-lg !bg-[var(--crm-red-soft)] !px-3 !py-2.5 !text-xs !font-medium !text-[var(--crm-red)]">{configuration.connectionError}</p> : null}
            {configuration?.connectionStatus === 'connected' ? <p className="!m-0 !flex !items-center !gap-2 !text-xs !font-semibold !text-[var(--crm-green)]"><CheckCircle2 className="!size-4" />Conexión verificada correctamente.</p> : null}
          </div>
        </div>

        {incidents.length ? <div className="!grid !gap-2 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4"><h3 className="!m-0 !text-sm !font-bold">Incidencias fiscales</h3>{incidents.map((incident) => <div className="!flex !items-center !justify-between !gap-3 !text-xs" key={incident.id}><span>{incident.status === 'pending' ? 'Pendiente de envío' : 'No se pudo completar el envío'}</span>{canEdit && incident.retryable ? <UiButton className="!min-h-8 !text-xs" disabled={disabled} onClick={() => void runAction(async () => { await retryFiscalOperation(tenantContext, incident.id); await refresh() })} type="button">Reintentar</UiButton> : null}</div>)}</div> : null}
        {canEdit ? <footer className="!flex !flex-wrap !justify-end !gap-2">
          {integrationProvider === 'verifacti' ? <UiButton className="!inline-flex !min-h-10 !items-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text)]" disabled={disabled || !configuration?.hasApiKey} onClick={() => void testConnection()} type="button"><RefreshCw className="!size-4" />Probar conexión</UiButton> : null}
          <UiButton className="!inline-flex !min-h-10 !items-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled} type="submit"><Save className="!size-4" />Guardar</UiButton>
        </footer> : null}
      </form>
    </section>
  )
}
