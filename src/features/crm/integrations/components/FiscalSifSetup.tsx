import { useCallback, useEffect, useState } from 'react'
import { Save, ShieldCheck } from 'lucide-react'
import { sileo } from 'sileo'
import { Button as UiButton } from '../../../../components/ui/Button'
import { Checkbox as UiCheckbox } from '../../../../components/ui/Checkbox'
import { Input as UiInput } from '../../../../components/ui/Input'
import type { TenantContext } from '../../../../types'
import { supabase } from '../../../../lib/supabase.ts'
import { saveFiscalSifSetup, type FiscalSifInstallation } from '../../../fiscal/local/setup.ts'
import { defaultFiscalInstallationIdentity } from '../../../fiscal/local/setupPolicy.ts'
import { UserFacingError } from '../../../../utils/UserFacingError.ts'
import { Field } from '../../shared/components/Field'
import type { RunAction } from '../../shared/types'

type Props = { disabled: boolean; runAction: RunAction; tenantContext: TenantContext }
type Venue = { id: string; name: string; legal_name: string | null; tax_id: string | null }
type Device = { id: string; venue_id: string; name: string; default_cash_register_id: string | null; can_take_payments: boolean }
type Register = { id: string; venue_id: string; name: string }
type FiscalSubject = { id: string; legal_name: string; nif: string }
type Row = {
  venue: Venue
  device: Device
  register: Register
  installation: FiscalSifInstallation
  replacement?: FiscalSifInstallation
  replaceExisting: boolean
}

const inputClass = '!h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none focus:!border-[var(--crm-blue)] focus:!shadow-[0_0_0_3px_var(--crm-blue-soft)]'

export function FiscalSifSetup({ disabled, runAction, tenantContext }: Props) {
  const canEdit = tenantContext.role === 'owner'
  const [legalName, setLegalName] = useState('')
  const [nif, setNif] = useState('')
  const [rows, setRows] = useState<Row[]>([])

  const refresh = useCallback(async () => {
    if (!supabase) throw new Error('Supabase no está configurado.')
    const [{ data: venueData, error: venueError }, { data: deviceData, error: deviceError }, { data: registerData, error: registerError }] = await Promise.all([
      supabase.from('venues').select('id,name,legal_name,tax_id').eq('tenant_id', tenantContext.tenantId).eq('is_active', true).order('name'),
      supabase.from('devices').select('id,venue_id,name,default_cash_register_id,can_take_payments').eq('tenant_id', tenantContext.tenantId).eq('is_active', true).order('name'),
      supabase.from('cash_registers').select('id,venue_id,name').eq('tenant_id', tenantContext.tenantId).eq('is_active', true).order('name'),
    ])
    if (venueError) throw venueError
    if (deviceError) throw deviceError
    if (registerError) throw registerError
    const installations = await (await import('../../../fiscal/local/setup.ts')).loadFiscalSifInstallations(tenantContext.tenantId)
    const subjectIds = [...new Set(installations.map(item => item.fiscal_subject_id))]
    const subjectResult = subjectIds.length === 1
      ? await supabase.from('fiscal_subjects').select('id,legal_name,nif').eq('tenant_id', tenantContext.tenantId).eq('id', subjectIds[0]).maybeSingle()
      : { data: null, error: null }
    if (subjectResult.error) throw subjectResult.error
    const nextRows = (deviceData as Device[]).filter(device => device.can_take_payments).flatMap(device => {
      const venue = (venueData as Venue[]).find(item => item.id === device.venue_id)
      const register = (registerData as Register[]).find(item => item.id === device.default_cash_register_id && item.venue_id === device.venue_id)
      if (!venue || !register) return []
      const saved = installations.find(item => item.device_id === device.id && item.cash_register_id === register.id)
      const conflicts = saved ? [] : installations.filter(item => item.device_id === device.id || item.cash_register_id === register.id)
      if (conflicts.length > 1) {
        throw new UserFacingError(`La caja ${register.name} y el dispositivo ${device.name} están asociados a instalaciones fiscales distintas. Requieren conciliación antes de sustituirlos.`)
      }
      const defaults = defaultFiscalInstallationIdentity(venue.id, register.id, device.id)
      return [{ venue, device, register, installation: saved ?? {
        id: '', tenant_id: tenantContext.tenantId, fiscal_subject_id: '', venue_id: venue.id,
        cash_register_id: register.id, device_id: device.id,
        installation_number: defaults.installationNumber, venue_code: defaults.venueCode,
        register_code: defaults.registerCode, installation_code: defaults.installationCode,
        mode: 'production', retired_at: null,
      }, replacement: conflicts[0], replaceExisting: false }]
    })
    const subject = subjectResult.data as FiscalSubject | null
    const firstVenue = (venueData as Venue[])[0]
    setLegalName(subject?.legal_name ?? firstVenue?.legal_name ?? '')
    setNif(subject?.nif ?? firstVenue?.tax_id ?? '')
    setRows(nextRows)
  }, [tenantContext.tenantId])

  useEffect(() => { void runAction(refresh) }, [refresh, runAction])

  function updateRow(index: number, field: 'installationNumber' | 'venueCode' | 'registerCode' | 'installationCode', value: string) {
    setRows(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, installation: {
      ...row.installation,
      [field === 'installationNumber' ? 'installation_number' : field.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`)]: value,
    } } : row))
  }

  async function submit() {
    await runAction(async () => {
      const registerOwners = new Map<string, Row>()
      for (const row of rows) {
        const prior = registerOwners.get(row.register.id)
        if (prior) {
          throw new UserFacingError(`Los dispositivos “${prior.device.name}” y “${row.device.name}” comparten la caja “${row.register.name}”. Asigna una caja distinta a cada dispositivo que pueda cobrar antes de activar sus instalaciones SIF.`)
        }
        registerOwners.set(row.register.id, row)
      }
      const pendingReplacement = rows.find(row => row.replacement && !row.replaceExisting)
      if (pendingReplacement) {
        throw new UserFacingError(`La caja ${pendingReplacement.register.name} conserva una instalación vinculada a otro dispositivo. Marca su sustitución controlada antes de guardar.`)
      }
      const installations = rows.map(row => ({
        ...(row.installation.id ? { installationId: row.installation.id } : {}), venueId: row.venue.id, cashRegisterId: row.register.id, deviceId: row.device.id,
        ...(row.replacement && row.replaceExisting ? { replaceInstallationId: row.replacement.id } : {}),
        installationNumber: row.installation.installation_number,
        venueCode: row.installation.venue_code, registerCode: row.installation.register_code, installationCode: row.installation.installation_code,
      }))
      await saveFiscalSifSetup(tenantContext.tenantId, { legalName, nif, installations })
      await refresh()
      sileo.success({ title: 'Configuración fiscal guardada', description: 'El titular y las cajas SIF ya están configurados.' })
    })
  }

  return <section className="!grid !gap-4 !rounded-2xl !bg-[var(--crm-surface)] !p-5 !text-[var(--crm-text)] !shadow-[var(--crm-shadow-card)]">
    <div><h2 className="!m-0 !text-base !font-bold">Titular e instalaciones fiscales</h2><p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Configura el NIF y una instalación inmutable para cada caja que vaya a emitir.</p></div>
    {!canEdit ? <p className="!m-0 !rounded-xl !bg-[var(--crm-blue-soft)] !px-4 !py-3 !text-xs !font-semibold !text-[var(--crm-blue)]">Solo el owner puede modificar la configuración fiscal.</p> : null}
    <div className="!grid !grid-cols-1 !gap-3 md:!grid-cols-2"><Field label="Razón social"><UiInput className={inputClass} disabled={disabled || !canEdit} value={legalName} onChange={event => setLegalName(event.target.value)} /></Field><Field label="NIF"><UiInput className={inputClass} disabled={disabled || !canEdit} value={nif} onChange={event => setNif(event.target.value.toUpperCase())} maxLength={9} /></Field></div>
    <div className="!grid !gap-3">{rows.map((row, index) => <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4" key={row.device.id}><div className="!font-semibold">{row.venue.name} · {row.device.name}</div><div className="!grid !grid-cols-1 !gap-3 sm:!grid-cols-2 lg:!grid-cols-4"><Field label="N.º instalación"><UiInput className={inputClass} disabled={disabled || !canEdit || Boolean(row.installation.id)} value={row.installation.installation_number} onChange={event => updateRow(index, 'installationNumber', event.target.value)} /></Field><Field label="Código local"><UiInput className={inputClass} disabled={disabled || !canEdit || Boolean(row.installation.id)} value={row.installation.venue_code} onChange={event => updateRow(index, 'venueCode', event.target.value)} maxLength={8} /></Field><Field label="Código caja"><UiInput className={inputClass} disabled={disabled || !canEdit || Boolean(row.installation.id)} value={row.installation.register_code} onChange={event => updateRow(index, 'registerCode', event.target.value)} maxLength={8} /></Field><Field label="Código instalación"><UiInput className={inputClass} disabled={disabled || !canEdit || Boolean(row.installation.id)} value={row.installation.installation_code} onChange={event => updateRow(index, 'installationCode', event.target.value)} maxLength={8} /></Field></div>{row.replacement ? <div className="!rounded-lg !bg-amber-500/10 !px-3 !py-3 !text-xs !text-amber-200"><p className="!mt-0 !mb-2">La caja o el dispositivo conserva la instalación <strong>{row.replacement.installation_number}</strong>. Se retirará sin borrar su cadena y se creará esta identidad nueva.</p><UiCheckbox checked={row.replaceExisting} disabled={disabled || !canEdit} onChange={checked => setRows(current => current.map((item, rowIndex) => rowIndex === index ? { ...item, replaceExisting: checked } : item))}>Confirmo la sustitución controlada de la instalación anterior</UiCheckbox></div> : null}</div>)}</div>
    <p className="!m-0 !flex !items-start !gap-2 !text-xs !text-[var(--crm-text-muted)]"><ShieldCheck className="!mt-0.5 !size-4 !shrink-0" />Una instalación ya utilizada no se puede reescribir. Sustituir un iPad requiere una instalación nueva.</p>
    {canEdit ? <footer className="!flex !justify-end"><UiButton className="!inline-flex !min-h-10 !items-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !rows.length} onClick={() => void submit()} type="button"><Save className="!size-4" />Guardar titular e instalaciones</UiButton></footer> : null}
  </section>
}
