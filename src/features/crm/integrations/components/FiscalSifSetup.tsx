import { useCallback, useEffect, useState } from 'react'
import { Save, ShieldCheck } from 'lucide-react'
import { sileo } from 'sileo'
import { Button as UiButton } from '../../../../components/ui/Button'
import { Input as UiInput } from '../../../../components/ui/Input'
import type { TenantContext } from '../../../../types'
import { supabase } from '../../../../lib/supabase.ts'
import { saveFiscalSifSetup, type FiscalSifInstallation } from '../../../fiscal/local/setup.ts'
import { Field } from '../../shared/components/Field'
import type { RunAction } from '../../shared/types'

type Props = { disabled: boolean; runAction: RunAction; tenantContext: TenantContext }
type Venue = { id: string; name: string; legal_name: string | null; tax_id: string | null }
type Device = { id: string; venue_id: string; name: string; default_cash_register_id: string | null }
type Register = { id: string; venue_id: string; name: string }
type Row = { venue: Venue; device: Device; register: Register; installation?: FiscalSifInstallation }

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
      supabase.from('devices').select('id,venue_id,name,default_cash_register_id').eq('tenant_id', tenantContext.tenantId).eq('is_active', true).order('name'),
      supabase.from('cash_registers').select('id,venue_id,name').eq('tenant_id', tenantContext.tenantId).eq('is_active', true).order('name'),
    ])
    if (venueError) throw venueError
    if (deviceError) throw deviceError
    if (registerError) throw registerError
    const installations = await (await import('../../../fiscal/local/setup.ts')).loadFiscalSifInstallations(tenantContext.tenantId)
    const nextRows = (deviceData as Device[]).flatMap(device => {
      const venue = (venueData as Venue[]).find(item => item.id === device.venue_id)
      const register = (registerData as Register[]).find(item => item.id === device.default_cash_register_id && item.venue_id === device.venue_id)
      if (!venue || !register) return []
      return [{ venue, device, register, installation: installations.find(item => item.device_id === device.id) }]
    })
    const firstVenue = (venueData as Venue[])[0]
    if (firstVenue) {
      setLegalName(current => current || firstVenue.legal_name || '')
      setNif(current => current || firstVenue.tax_id || '')
    }
    setRows(nextRows)
  }, [tenantContext.tenantId])

  useEffect(() => { void runAction(refresh) }, [refresh, runAction])

  function updateRow(index: number, field: 'installationNumber' | 'venueCode' | 'registerCode' | 'installationCode', value: string) {
    setRows(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, installation: {
      id: row.installation?.id ?? '', tenant_id: tenantContext.tenantId, fiscal_subject_id: row.installation?.fiscal_subject_id ?? '', venue_id: row.venue.id,
      cash_register_id: row.register.id, device_id: row.device.id, installation_number: row.installation?.installation_number ?? '', venue_code: row.installation?.venue_code ?? '', register_code: row.installation?.register_code ?? '', installation_code: row.installation?.installation_code ?? '', mode: 'production', retired_at: null,
      ...row.installation, [field === 'installationNumber' ? 'installation_number' : field.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`)]: value,
    } } : row))
  }

  async function submit() {
    await runAction(async () => {
      const installations = rows.map(row => ({
        ...(row.installation?.id ? { installationId: row.installation.id } : {}), venueId: row.venue.id, cashRegisterId: row.register.id, deviceId: row.device.id,
        installationNumber: row.installation?.installation_number || `${row.venue.name}-${row.device.name}`,
        venueCode: row.installation?.venue_code || 'LOCAL', registerCode: row.installation?.register_code || 'CAJA', installationCode: row.installation?.installation_code || 'INST1',
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
    <div className="!grid !gap-3">{rows.map((row, index) => <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4" key={row.device.id}><div className="!font-semibold">{row.venue.name} · {row.device.name}</div><div className="!grid !grid-cols-1 !gap-3 sm:!grid-cols-2 lg:!grid-cols-4"><Field label="N.º instalación"><UiInput className={inputClass} disabled={disabled || !canEdit} value={row.installation?.installation_number ?? ''} onChange={event => updateRow(index, 'installationNumber', event.target.value)} /></Field><Field label="Código local"><UiInput className={inputClass} disabled={disabled || !canEdit} value={row.installation?.venue_code ?? ''} onChange={event => updateRow(index, 'venueCode', event.target.value)} maxLength={8} /></Field><Field label="Código caja"><UiInput className={inputClass} disabled={disabled || !canEdit} value={row.installation?.register_code ?? ''} onChange={event => updateRow(index, 'registerCode', event.target.value)} maxLength={8} /></Field><Field label="Código instalación"><UiInput className={inputClass} disabled={disabled || !canEdit} value={row.installation?.installation_code ?? ''} onChange={event => updateRow(index, 'installationCode', event.target.value)} maxLength={8} /></Field></div></div>)}</div>
    <p className="!m-0 !flex !items-start !gap-2 !text-xs !text-[var(--crm-text-muted)]"><ShieldCheck className="!mt-0.5 !size-4 !shrink-0" />Una instalación ya utilizada no se puede reescribir. Sustituir un iPad requiere una instalación nueva.</p>
    {canEdit ? <footer className="!flex !justify-end"><UiButton className="!inline-flex !min-h-10 !items-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !rows.length} onClick={() => void submit()} type="button"><Save className="!size-4" />Guardar titular e instalaciones</UiButton></footer> : null}
  </section>
}
